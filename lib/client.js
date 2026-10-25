/**
 * dsh-session-load-tuner — 浏览器半边。
 *
 * 这是一个 Module Loader 包：本文件是 package.json `./client` 的导出，由页面以
 * `window.__ModuleLoader__.load({ id, factory })` 注册。
 *
 * 它有两部分：
 *
 *   1. 传输层改写（无界面）：拦下发往网关的 `session/follow` open 帧，把
 *      `payload.args.request.maxMessages` / `turnWindow` 换成配置里的值。
 *      首屏窗口在 dsh 客户端里是模块私有常量（HISTORY_PAGE_OPTIONS =
 *      { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }），
 *      插件拿不到那个常量；但网关接受的正是这条请求本身，所以在
 *      `WebSocket.prototype.send` 上改写还没发出去的 JSON 是等价且不依赖内部
 *      结构的。
 *
 *   2. 设置页：在「设置 → 会话加载」里提供开关和数字输入，读写的是宿主这条
 *      entry 的 volatile Config（通过 `configForms`，命名空间 = 条目 id
 *      "session-load-tuner"）。写回后窗口参数在下次打开会话时生效，压缩对新
 *      连接生效，都不需要重启 dsh-web。
 *
 * 配置还没就绪时按「不改写」处理，退回原生行为——宁可慢一点，也不要在用户
 * 关掉开关时仍然改包。
 *
 * @module dsh-session-load-tuner/client
 */

window.__ModuleLoader__.load({
	id: "dsh-session-load-tuner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		/** 宿主条目 id，也是设置文档里这条配置的命名空间。 */
		const NAMESPACE = "session-load-tuner";

		/** 与宿主 Config 的默认值保持一致。 */
		const DEFAULTS = Object.freeze({
			maxMessages: 120,
			minMessages: 24,
			minTurns: 2,
			wsDeflate: false,
			wsDeflateThreshold: 1024,
		});

		/** 数值字段的取值范围，与宿主 schemastery 的约束一致。 */
		const RANGES = Object.freeze({
			maxMessages: [20, 500],
			minMessages: [1, 500],
			minTurns: [1, 50],
			wsDeflateThreshold: [0, 65536],
		});

		/** 「恢复默认」要写的字段顺序（maxMessages 先写，避免 minMessages 暂时越界）。 */
		const FIELD_ORDER = Object.freeze([
			"maxMessages",
			"minMessages",
			"minTurns",
			"wsDeflate",
			"wsDeflateThreshold",
		]);

		/** 已安装标记：热替换同一个 bundle 时避免给 send 套第二层。 */
		const HOOK = Symbol.for("dsh.session-load-tuner.send-hook");

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

			const maxMessages = clampInt(config.maxMessages, 20, 500, DEFAULTS.maxMessages);
			request.maxMessages = maxMessages;
			const turnWindow = request.turnWindow;
			if (turnWindow !== null && typeof turnWindow === "object") {
				turnWindow.minMessages = clampInt(
					config.minMessages,
					1,
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

		// #region 设置页样式

		/** 样式的稳定标识：热替换时复用同一个 style 标签。 */
		const STYLE_TAG_ID = "dsh-session-load-tuner/SessionLoadSection.module.css";

		const CSS = [
			".dsh-slt-section{max-width:720px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}",
			".dsh-slt-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".dsh-slt-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-slt-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-slt-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dsh-slt-rows{display:flex;flex-direction:column;margin:4px 0 0}",
			".dsh-slt-row{display:flex;align-items:center;justify-content:space-between;gap:16px 24px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
			".dsh-slt-row:last-child{border-bottom:none}",
			".dsh-slt-label{flex:1;min-width:200px}",
			".dsh-slt-name{font-size:14px;line-height:20px}",
			".dsh-slt-desc{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dsh-slt-number{display:flex;align-items:center;gap:6px}",
			".dsh-slt-number input{width:96px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:right}",
			".dsh-slt-number input:disabled{opacity:.5}",
			".dsh-slt-suffix{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-slt-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer}",
			".dsh-slt-switch input{position:absolute;opacity:0;width:0;height:0}",
			".dsh-slt-track{position:relative;display:inline-block;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .15s}",
			".dsh-slt-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}",
			".dsh-slt-switch input:checked + .dsh-slt-track{background:var(--dsw-alias-state-business-primary,#4d6bfe)}",
			".dsh-slt-switch input:checked + .dsh-slt-track .dsh-slt-thumb{transform:translateX(16px)}",
			".dsh-slt-switch input:disabled + .dsh-slt-track{opacity:.5}",
			".dsh-slt-actions{display:flex;gap:8px;margin-top:2px}",
			".dsh-slt-btn{padding:6px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}",
			".dsh-slt-btn:disabled{opacity:.5;cursor:default}",
		].join("");

		/** 把设置页样式插进文档；热替换时复用同一个标签。 */
		function insertStyles() {
			if (typeof document === "undefined") return;
			const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) ?? null;
			if (existing !== null) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-load-tuner";
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.append(tag);
		}

		// #endregion

		// #region 设置页文案

		/** 简体中文（键集的事实来源）。 */
		const zh = {
			nav: "会话加载",
			title: "会话加载",
			intro: "控制打开会话时下载多少历史。首屏越小越快，往上滚动仍会继续加载更早的内容。",
			"maxMessages.title": "首屏消息条数",
			"maxMessages.description": "点开会话时一次载入的消息数上限（原生 500）",
			"minMessages.title": "首屏最少消息数",
			"minMessages.description": "至少回退到最近一个轮次起点所需的消息数，不能大于上面的条数",
			"minTurns.title": "首屏最少轮次",
			"minTurns.description": "首屏至少覆盖的完整轮次数",
			"wsDeflate.title": "WebSocket 压缩",
			"wsDeflate.description": "给历史数据流开 permessage-deflate；只影响新连接，链路上若有代理吃掉扩展协商则不生效",
			"wsDeflateThreshold.title": "压缩阈值",
			"wsDeflateThreshold.description": "小于该字节数的帧不压缩，避免小帧白烧 CPU",
			statusPrefix: "当前生效：首屏",
			statusMiddle: "条 · 压缩",
			onSlot: "开启",
			offSlot: "关闭",
			unavailable: "这一条配置暂不可用：宿主没有提供该命名空间的设置文档。",
			reset: "恢复默认",
			appliesOnReopen: "窗口参数在下次打开会话时生效；压缩设置对新建立的连接生效（必要时重启 dsh-web）。",
			bytes: "字节",
			messages: "条",
			turns: "轮",
		};

		/** English mirror。 */
		const en = {
			nav: "Session loading",
			title: "Session loading",
			intro: "Controls how much history is downloaded when a session opens. A smaller first screen is faster; scrolling up still loads older content.",
			"maxMessages.title": "Messages on the first screen",
			"maxMessages.description": "Upper bound of messages loaded when a session opens (native: 500)",
			"minMessages.title": "Minimum messages",
			"minMessages.description": "Messages needed to reach the most recent turn boundary; must not exceed the value above",
			"minTurns.title": "Minimum turns",
			"minTurns.description": "Complete turns covered by the first screen",
			"wsDeflate.title": "WebSocket compression",
			"wsDeflate.description": "Enables permessage-deflate for the history stream; new connections only, and a proxy that drops the extension negotiation defeats it",
			"wsDeflateThreshold.title": "Compression threshold",
			"wsDeflateThreshold.description": "Frames smaller than this stay uncompressed, so small frames do not burn CPU",
			statusPrefix: "Active: first screen",
			statusMiddle: "messages · compression",
			onSlot: "on",
			offSlot: "off",
			unavailable: "This entry is unavailable: the host serves no settings document for this namespace.",
			reset: "Restore defaults",
			appliesOnReopen: "Window changes apply the next time a session opens; compression applies to new connections (restart dsh-web if needed).",
			bytes: "bytes",
			messages: "messages",
			turns: "turns",
		};

		// #endregion

		// #region 设置页组件

		/**
		 * 把当前配置拼成一行状态文案。
		 *
		 * @param t - 文案函数。
		 * @param maxMessages - 当前首屏条数。
		 * @param deflate - 当前压缩开关。
		 * @returns 状态行。
		 */
		function statusText(t, maxMessages, deflate) {
			return `${t("statusPrefix")} ${maxMessages} ${t("statusMiddle")}${t(deflate === true ? "onSlot" : "offSlot")}`;
		}

		/**
		 * 一行设置：左侧标题+说明，右侧控件。
		 *
		 * @param field - 配置字段名（用作 DOM 标记与 key）。
		 * @param control - 右侧控件。
		 * @param t - 文案函数。
		 * @returns 行元素。
		 */
		function row(field, control, t) {
			return h(
				"div",
				{ className: "dsh-slt-row", key: field },
				h(
					"div",
					{ className: "dsh-slt-label" },
					h("div", { className: "dsh-slt-name" }, t(`${field}.title`)),
					h("div", { className: "dsh-slt-desc" }, t(`${field}.description`)),
				),
				h("div", { className: "dsh-slt-control" }, control),
			);
		}

		/**
		 * 设置页「会话加载」。
		 *
		 * 只依赖宿主注入的 `useConfig` / `setField`，自己不开 React 状态：输入框
		 * 是非受控的，失焦（或回车）时提交，配置回写后 key 变化会以新值重挂。
		 *
		 * @param props - 注入的配置钩子与文案函数。
		 * @returns 页面元素。
		 */
		function SessionLoadSection({ useConfig, setField, t }) {
			const state = useConfig((snapshot) => snapshot);
			const ready = state !== undefined && state !== null && state.status === "ready";
			const value = ready && state.value !== null && typeof state.value === "object" ? state.value : DEFAULTS;
			const locked = ready !== true || state.writable !== true;
			const read = (field) => (value[field] === undefined ? DEFAULTS[field] : value[field]);

			const write = (field, next) => {
				try {
					void Promise.resolve(setField(field, next)).catch(() => undefined);
				} catch {
					/* 写入失败由表单自身提示，这里保持页面可用 */
				}
			};

			/** 提交一个数字字段：夹到合法区间，非法输入回显原值。 */
			const commitNumber = (field, target) => {
				const [min, max] = RANGES[field];
				const current = read(field);
				const parsed = Number(target.value);
				const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : current;
				target.value = String(next);
				if (next !== current) write(field, next);
			};

			/** 数字行：非受控 input，失焦/回车提交。 */
			const numberRow = (field, unit) =>
				row(
					field,
					h(
						"div",
						{ className: "dsh-slt-number" },
						h("input", {
							key: `${field}:${String(read(field))}`,
							type: "number",
							inputMode: "numeric",
							min: RANGES[field][0],
							max: RANGES[field][1],
							step: 1,
							defaultValue: String(read(field)),
							disabled: locked,
							"data-field": field,
							onBlur: (event) => commitNumber(field, event.currentTarget),
							onKeyDown: (event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							},
						}),
						h("span", { className: "dsh-slt-suffix" }, t(unit)),
					),
					t,
				);

			/** 开关行：非受控 checkbox，change 即提交。 */
			const switchRow = (field) =>
				row(
					field,
					h(
						"label",
						{ className: "dsh-slt-switch" },
						h("input", {
							key: `${field}:${String(read(field))}`,
							type: "checkbox",
							defaultChecked: read(field) === true,
							disabled: locked,
							"data-field": field,
							onChange: (event) => write(field, event.currentTarget.checked === true),
						}),
						h("span", { className: "dsh-slt-track" }, h("span", { className: "dsh-slt-thumb" })),
					),
					t,
				);

			/** 恢复默认：按顺序把每个字段写回默认值。 */
			const reset = () => {
				let chain = Promise.resolve();
				for (const field of FIELD_ORDER) {
					chain = chain.then(() => {
						try {
							return setField(field, DEFAULTS[field]);
						} catch {
							return undefined;
						}
					}).catch(() => undefined);
				}
				void chain;
			};

			return h(
				"div",
				{ className: "dsh-slt-section" },
				h("h2", { className: "dsh-slt-title" }, t("title")),
				h("p", { className: "dsh-slt-intro" }, t("intro")),
				ready === true ? null : h("p", { className: "dsh-slt-note", "data-state": "unavailable" }, t("unavailable")),
				h("p", { className: "dsh-slt-status", "data-state": "active" }, statusText(t, read("maxMessages"), read("wsDeflate"))),
				h(
					"div",
					{ className: "dsh-slt-rows" },
					numberRow("maxMessages", "messages"),
					numberRow("minMessages", "messages"),
					numberRow("minTurns", "turns"),
					switchRow("wsDeflate"),
					numberRow("wsDeflateThreshold", "bytes"),
				),
				h("p", { className: "dsh-slt-note" }, t("appliesOnReopen")),
				h(
					"div",
					{ className: "dsh-slt-actions" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-slt-btn",
							"data-action": "reset",
							disabled: locked,
							onClick: reset,
						},
						t("reset"),
					),
				),
			);
		}

		// #endregion

		/** 需要的客户端服务：设置表单、槽位、文案。 */
		const inject = ["configForms", "slots", "locale"];

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

			const translate = typeof ctx.locale?.bind === "function" ? ctx.locale.bind(NAMESPACE) : (key) => key;
			if (typeof ctx.locale?.register === "function") {
				ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "session-load-tuner: dictionaries");
				insertStyles();
			}

			if (typeof ctx.slots?.inject !== "function" || typeof ctx.configForms?.whileServed !== "function") return;
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NAMESPACE], () =>
						ctx.slots.inject("settings.section", () =>
							ctx.slots.register(
								{
									name: "settings.section",
									id: NAMESPACE,
									// 6 把页面排在「通用」(0)/「提示音」(5) 之后、「模型」(10) 之前。
									order: 6,
									label: () => translate("nav"),
									locale: NAMESPACE,
									inject: () => ({
										hooks: { config: form },
										setField: (field, next) => form.set(field, next),
									}),
								},
								SessionLoadSection,
							),
						),
					),
				"session-load-tuner: settings section",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		/* 给测试用：纯函数、钩子与页面组件。 */
		exports.__applyWindow = applyWindow;
		exports.__rewriteFrame = rewriteFrame;
		exports.__installSendHook = installSendHook;
		exports.__Section = SessionLoadSection;
		exports.__defaults = DEFAULTS;
		exports.__ranges = RANGES;
		exports.__dictionaries = { zh, en };
		return module.exports;
	},
});
