/**
 * dsh-payload-tuner — 浏览器半边。
 *
 * 这是一个 Module Loader 包：本文件是 package.json `./client` 的导出，由页面以
 * `window.__ModuleLoader__.load({ id, factory })` 注册。
 *
 * 它做的事只有一件：拦下发往网关的 `session/follow` open 帧，把
 * `payload.args.request.maxMessages` / `turnWindow` 换成配置里的值。
 *
 * 为什么要在传输层改：首屏窗口大小在 dsh 客户端里是模块私有常量
 * （HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50,
 * minTurns: 2 } }），插件拿不到那个常量；但网关接受的正是这条请求本身，所以在
 * `WebSocket.prototype.send` 上改写还没发出去的 JSON 是等价且不依赖内部结构的。
 *
 * 配置来自 `configForms`（命名空间 = 宿主条目 id "payload-tuner"），每次发帧前
 * 现读，所以改完配置刷新页面即生效。配置还没就绪时按「不改写」处理，退回原生
 * 行为——宁可慢一点，也不要在用户关掉开关时仍然改包。
 *
 * @module dsh-payload-tuner/client
 */

window.__ModuleLoader__.load({
	id: "dsh-payload-tuner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** 宿主条目 id，也是设置文档里这条配置的命名空间。 */
		const NAMESPACE = "payload-tuner";

		/** 与宿主 Config 的默认值保持一致（设置文档未就绪时的兜底不写死这些值，见 readConfig）。 */
		const DEFAULTS = Object.freeze({
			enabled: true,
			maxMessages: 120,
			minMessages: 24,
			minTurns: 2,
		});

		/** 已安装标记：热替换同一个 bundle 时避免给 send 套第二层。 */
		const HOOK = Symbol.for("dsh.payload-tuner.send-hook");

		/** 只对包含这个片段的字符串尝试解析，避免对每个小帧都 JSON.parse 一次。 */
		const FOLLOW_MARKER = "\"session/follow\"";

		/**
		 * 把一个值夹到整数区间。
		 *
		 * @param value - 配置里的原始值。
		 * @param min - 允许的最小值。
		 * @param max - 允许的最大值。
		 * @param fallback - 不可用时的默认值。
		 * @returns 夹紧后的整数。
		 */
		function clampInt(value, min, max, fallback) {
			const number = Number(value);
			if (!Number.isFinite(number)) return fallback;
			return Math.min(max, Math.max(min, Math.trunc(number)));
		}

		/**
		 * 按配置改写一帧 `session/follow` open 请求。
		 *
		 * 只动 maxMessages 与 turnWindow；address、assistantStream 等原样保留。
		 * 服务端要求 turnWindow.minMessages 不得超过 maxMessages，这里一并夹住。
		 *
		 * @param frame - 已解析的待发送帧。
		 * @param config - 当前配置（可能为空）。
		 * @returns 是否真的改写过。
		 */
		function applyWindow(frame, config) {
			if (frame === null || typeof frame !== "object") return false;
			if (frame.type !== "open" || frame.endpoint !== "session/follow") return false;
			const request = frame.payload?.args?.request;
			if (request === null || typeof request !== "object") return false;
			if (config === undefined || config === null || typeof config !== "object") return false;
			if (config.enabled === false) return false;

			const maxMessages = clampInt(config.maxMessages, 20, 500, DEFAULTS.maxMessages);
			request.maxMessages = maxMessages;
			const turnWindow = request.turnWindow;
			if (turnWindow !== null && typeof turnWindow === "object") {
				turnWindow.minMessages = clampInt(
					config.minMessages,
					0,
					maxMessages,
					Math.min(DEFAULTS.minMessages, maxMessages),
				);
				turnWindow.minTurns = clampInt(config.minTurns, 1, 50, DEFAULTS.minTurns);
			}
			return true;
		}

		/**
		 * 一串待发送的数据是否是 mux 的 JSON 帧，是则尝试改写。
		 *
		 * @param data - WebSocket.send 的入参。
		 * @param readConfig - 读取当前配置。
		 * @returns 改写后的字符串，未改写时为 undefined。
		 */
		function rewriteFrame(data, readConfig) {
			if (typeof data !== "string" || data.length < 40 || data.indexOf(FOLLOW_MARKER) === -1) return undefined;
			let frame;
			try {
				frame = JSON.parse(data);
			} catch {
				return undefined;
			}
			let config;
			try {
				config = readConfig();
			} catch {
				config = undefined;
			}
			if (!applyWindow(frame, config)) return undefined;
			return JSON.stringify(frame);
		}

		/**
		 * 安装 send 钩子。多个 apply 之间共享，只包装一次。
		 *
		 * @param readConfig - 每次发帧前调用的配置读取器。
		 */
		function installSendHook(readConfig) {
			const WebSocketClass = globalThis.WebSocket;
			if (typeof WebSocketClass !== "function" || WebSocketClass.prototype === undefined) return;
			const proto = WebSocketClass.prototype;
			if (proto[HOOK] !== undefined) {
				proto[HOOK].read = readConfig;
				return;
			}
			const original = proto.send;
			if (typeof original !== "function") return;
			const state = { read: readConfig };
			Object.defineProperty(proto, HOOK, { value: state, enumerable: false, configurable: true });
			proto.send = function send(data) {
				let rewritten;
				try {
					rewritten = rewriteFrame(data, state.read);
				} catch {
					rewritten = undefined;
				}
				return original.call(this, rewritten === undefined ? data : rewritten);
			};
		}

		/** 需要的客户端服务：设置表单。 */
		const inject = ["configForms"];

		/**
		 * 客户端插件入口。
		 *
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			let form;
			try {
				form = ctx.configForms?.get?.(NAMESPACE);
			} catch {
				form = undefined;
			}
			/**
			 * 当前配置，或 undefined。
			 *
			 * 设置文档还没加载完时 `value` 是 undefined：返回 undefined 表示「按原生
			 * 行为处理」，不要在用户显式关掉之前擅自改包。
			 *
			 * @returns 配置对象或 undefined。
			 */
			const readConfig = () => {
				try {
					const snapshot = form?.getSnapshot?.();
					const value = snapshot?.value;
					return value !== null && typeof value === "object" ? value : undefined;
				} catch {
					return undefined;
				}
			};
			installSendHook(readConfig);
		}

		exports.apply = apply;
		exports.inject = inject;
		/* 给测试用：纯函数与钩子。 */
		exports.__applyWindow = applyWindow;
		exports.__rewriteFrame = rewriteFrame;
		exports.__installSendHook = installSendHook;
		exports.__defaults = DEFAULTS;
		return module.exports;
	},
});
