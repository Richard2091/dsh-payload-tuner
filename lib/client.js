/**
 * dsh-session-load-tuner — 浏览器半边。
 *
 * 这是一个 Module Loader 包：本文件是 package.json `./client` 的导出，由页面以
 * `window.__ModuleLoader__.load({ id, factory })` 注册。
 *
 * 它做三类事：
 *
 *   1. 首屏条数：拦下发往网关的 `session/follow` open 帧，把
 *      `payload.args.request.maxMessages` 换成配置值（原生硬编码 500），并去掉
 *      `turnWindow`，让首屏严格按条数截断、结果可预期。
 *   2. 翻页条数：拦下 HTTP 的 `session/page`（往上滚时那一页）请求，同样换成
 *      配置值并去掉 `turnWindow`。
 *   3. 懒加载 + 设置页：滚到接近顶部时自动触发一次「加载更早」；「设置 → 会话加载」
 *      提供条数、懒加载、压缩开关，读写宿主这条 entry 的 volatile Config。
 *
 * 配置还没就绪时一律「不改写」，退回 dsh 原生行为——宁可慢一点，也不要在用户
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
			lazyLoad: true,
			wsDeflate: false,
			wsDeflateThreshold: 1024,
		});

		/** 数值字段的取值范围，与宿主 schemastery 的约束一致。 */
		const RANGES = Object.freeze({
			maxMessages: [20, 500],
			wsDeflateThreshold: [0, 65536],
		});

		/** 「恢复默认」按这个顺序写回。 */
		const FIELD_ORDER = Object.freeze(["maxMessages", "lazyLoad", "wsDeflate", "wsDeflateThreshold"]);

		/** 已安装标记：热替换 bundle 时不重复包装。 */
		const HOOK = Symbol.for("dsh.session-load-tuner.hooks");

		/** 只对包含这个片段的字符串尝试解析，避免对每个小帧都 JSON.parse。 */
		const FOLLOW_MARKER = "\"session/follow\"";

		/** 往上滚到距顶多少像素内触发懒加载。 */
		const PREFETCH_PX = 800;

		/** 「加载更早」按钮上的文案（用于在 DOM 里认出它）。 */
		const OLDER_LABELS = ["加载更早", "Load earlier"];

		/**
		 * 把一个值夹到整数区间。
		 *
		 * @param value - 原始值。
		 * @param min - 最小值。
		 * @param max - 最大值。
		 * @param fallback - 不可用时的默认值。
		 * @returns 夹紧后的整数。
		 */
		function clampInt(value, min, max, fallback) {
			const number = Number(value);
			if (!Number.isFinite(number)) return fallback;
			return Math.min(max, Math.max(min, Math.trunc(number)));
		}

		/**
		 * 一份配置里“首屏条数”的最终取值。
		 *
		 * @param config - 配置对象（可能为空）。
		 * @returns 消息条数。
		 */
		function windowSizeOf(config) {
			return clampInt(config?.maxMessages, 20, 500, DEFAULTS.maxMessages);
		}

		/**
		 * 读配置，任何异常都当作“没有配置”。
		 *
		 * @param readConfig - 读取器。
		 * @returns 配置对象或 undefined。
		 */
		function safeRead(readConfig) {
			try {
				return readConfig();
			} catch {
				return undefined;
			}
		}

		/**
		 * 按配置改写 `session/follow` open 帧。
		 *
		 * 只动 maxMessages 并去掉 turnWindow（原生 500 条 + 轮次对齐会让条数浮动，
		 * 这里要的是“打开会话就加载 N 条”这个可预期的语义）。
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
			request.maxMessages = windowSizeOf(config);
			delete request.turnWindow;
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
			if (!applyWindow(frame, safeRead(readConfig))) return undefined;
			return JSON.stringify(frame);
		}

		/**
		 * 改写一页 `session/page`（HTTP RPC）的请求体。
		 *
		 * @param body - 原始请求体文本。
		 * @param config - 当前配置。
		 * @returns 改写后的请求体，未改写时为 undefined。
		 */
		function rewritePageBody(body, config) {
			if (typeof body !== "string" || config === undefined || config === null || typeof config !== "object") return undefined;
			let frame;
			try {
				frame = JSON.parse(body);
			} catch {
				return undefined;
			}
			const request = frame?.args?.request;
			if (request === null || typeof request !== "object") return undefined;
			request.maxMessages = windowSizeOf(config);
			delete request.turnWindow;
			return JSON.stringify(frame);
		}

		/**
		 * 安装 WebSocket.send 钩子（首屏）。
		 *
		 * 这个钩子同时创建共享的原型状态，后面的 fetch / 懒加载都挂在同一份状态上。
		 *
		 * @param readConfig - 每次发帧前调用的配置读取器。
		 */
		function installSendHook(readConfig) {
			const WebSocketClass = globalThis.WebSocket;
			if (typeof WebSocketClass !== "function" || WebSocketClass.prototype === undefined) return;
			const proto = WebSocketClass.prototype;
			proto[HOOK] ??= { send: undefined, fetch: undefined, autoLoad: undefined };
			const state = proto[HOOK];
			if (state.send !== undefined) {
				state.send.read = readConfig;
				return;
			}
			const original = proto.send;
			if (typeof original !== "function") return;
			state.send = { read: readConfig };
			proto.send = function send(data) {
				let rewritten;
				try {
					rewritten = rewriteFrame(data, state.send.read);
				} catch {
					rewritten = undefined;
				}
				return original.call(this, rewritten === undefined ? data : rewritten);
			};
		}

		/**
		 * 安装 fetch 钩子（翻页）。
		 *
		 * @param readConfig - 每次请求前调用的配置读取器。
		 */
		function installFetchHook(readConfig) {
			const original = globalThis.fetch;
			if (typeof original !== "function") return;
			const state = globalThis.WebSocket?.prototype?.[HOOK];
			if (state === undefined) return;
			if (state.fetch !== undefined) {
				state.fetch.read = readConfig;
				return;
			}
			state.fetch = { read: readConfig };
			globalThis.fetch = function fetch(input, init) {
				try {
					const url = typeof input === "string" ? input : input?.url;
					if (typeof url === "string" && url.indexOf("/api/session/page") !== -1 && typeof init?.body === "string") {
						const rewritten = rewritePageBody(init.body, state.fetch.read());
						if (rewritten !== undefined) return original(input, { ...init, body: rewritten });
					}
				} catch {
					/* 任何意外都按原样放行 */
				}
				return original(input, init);
			};
		}

		/**
		 * 滚动位置是否已经接近顶部（懒加载的触发条件之一）。
		 *
		 * @param metrics - `{ scrollTop, scrollHeight, clientHeight }`。
		 * @returns 是否应预取。
		 */
		function shouldPrefetch(metrics) {
			if (metrics === undefined || metrics === null) return false;
			const { scrollTop, scrollHeight, clientHeight } = metrics;
			if (![scrollTop, scrollHeight, clientHeight].every((value) => typeof value === "number" && Number.isFinite(value))) return false;
			if (scrollHeight <= clientHeight) return false;
			return scrollTop <= PREFETCH_PX;
		}

		/**
		 * 在容器里找可点的「加载更早」按钮。
		 *
		 * @param root - 聊天流容器。
		 * @returns 按钮元素或 undefined。
		 */
		function findOlderButton(root) {
			if (root === undefined || root === null || typeof root.querySelectorAll !== "function") return undefined;
			for (const button of root.querySelectorAll("button")) {
				if (button === null || button === undefined) continue;
				if (button.disabled === true) continue;
				const text = typeof button.textContent === "string" ? button.textContent.trim() : "";
				if (OLDER_LABELS.includes(text)) return button;
			}
			return undefined;
		}

		/**
		 * 安装懒加载：滚动到接近顶部时自动点一次「加载更早」。
		 *
		 * @param readConfig - 读取当前配置。
		 * @param doc - 文档对象（测试可注入）。
		 */
		function installAutoLoad(readConfig, doc) {
			const target = doc ?? (typeof document === "undefined" ? undefined : document);
			if (target === undefined || target === null || typeof target.addEventListener !== "function") return;
			const state = globalThis.WebSocket?.prototype?.[HOOK];
			if (state === undefined) return;
			if (state.autoLoad !== undefined) {
				state.autoLoad.read = readConfig;
				return;
			}
			let lastClick = 0;
			let scheduled = false;
			/** 判断并触发一次加载。 */
			const attempt = (event) => {
				try {
					const config = state.autoLoad.read();
					if (config === undefined || config === null || config.lazyLoad === false) return;
					const scroller = event?.target;
					if (!shouldPrefetch(scroller)) return;
					const flow = target.querySelector?.("[data-chat-flow]");
					if (flow === undefined || flow === null) return;
					if (typeof scroller.contains === "function" && !scroller.contains(flow)) return;
					if (Date.now() - lastClick < 800) return;
					const button = findOlderButton(flow);
					if (button === undefined) return;
					lastClick = Date.now();
					button.click();
				} catch {
					/* 懒加载失败不影响滚动 */
				}
			};
			/** 滚动回调：一帧最多处理一次。 */
			const onScroll = (event) => {
				if (scheduled) return;
				scheduled = true;
				const run = () => {
					scheduled = false;
					attempt(event);
				};
				if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(run);
				else setTimeout(run, 16);
			};
			target.addEventListener("scroll", onScroll, true);
			state.autoLoad = {
				read: readConfig,
				remove: () => target.removeEventListener("scroll", onScroll, true),
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
			intro: "控制打开会话时加载多少历史。条数越小，打开越快；往上滚动仍会继续加载更早的内容。",
			"maxMessages.title": "打开会话时加载的条数",
			"maxMessages.description": "替代 dsh 原生的 500 条；只影响首屏这一页（20–500）",
			"lazyLoad.title": "懒加载",
			"lazyLoad.description": "开启后快滚到最上面之前自动拉上一页，不用点「加载更早」；关闭则只在你点按钮时加载",
			"wsDeflate.title": "WebSocket 压缩",
			"wsDeflate.description": "给历史数据流开 permessage-deflate；只影响新连接，链路上若有代理吃掉扩展协商则不生效",
			"wsDeflateThreshold.title": "压缩阈值",
			"wsDeflateThreshold.description": "小于该字节数的帧不压缩，避免小帧白烧 CPU",
			statusPrefix: "当前生效：首屏",
			statusMiddle: "条 · 压缩",
			lazyMiddle: " · 懒加载",
			onSlot: "开启",
			offSlot: "关闭",
			unavailable: "这一条配置暂不可用：宿主没有提供该命名空间的设置文档。",
			reset: "恢复默认",
			appliesOnReopen: "条数在下次打开会话时生效（当前会话刷新页面亦可）；压缩设置对新建立的连接生效（必要时重启 dsh-web）。",
			bytes: "字节",
			messages: "条",
		};

		/** English mirror。 */
		const en = {
			nav: "Session loading",
			title: "Session loading",
			intro: "Controls how much history is loaded when a session opens. A smaller number opens faster; scrolling up still loads older content.",
			"maxMessages.title": "Messages loaded when a session opens",
			"maxMessages.description": "Replaces dsh's native 500; applies to the first page only (20–500)",
			"lazyLoad.title": "Lazy loading",
			"lazyLoad.description": "On: fetches the previous page shortly before you reach the top, without pressing \"Load earlier\". Off: loads only when you press it",
			"wsDeflate.title": "WebSocket compression",
			"wsDeflate.description": "Enables permessage-deflate for the history stream; new connections only, and a proxy that drops the extension negotiation defeats it",
			"wsDeflateThreshold.title": "Compression threshold",
			"wsDeflateThreshold.description": "Frames smaller than this stay uncompressed, so small frames do not burn CPU",
			statusPrefix: "Active: first screen",
			statusMiddle: "messages · compression",
			lazyMiddle: " · lazy loading",
			onSlot: "on",
			offSlot: "off",
			unavailable: "This entry is unavailable: the host serves no settings document for this namespace.",
			reset: "Restore defaults",
			appliesOnReopen: "The message count applies the next time a session opens (or after a page refresh); compression applies to new connections (restart dsh-web if needed).",
			bytes: "bytes",
			messages: "messages",
		};

		// #endregion

		// #region 设置页组件

		/**
		 * 状态行：当前条数 / 压缩 / 懒加载。
		 *
		 * @param t - 文案函数。
		 * @param config - 当前配置。
		 * @returns 状态文本。
		 */
		function statusText(t, config) {
			const lazy = config.lazyLoad === false ? t("offSlot") : t("onSlot");
			const deflate = config.wsDeflate === true ? t("onSlot") : t("offSlot");
			return `${t("statusPrefix")} ${windowSizeOf(config)} ${t("statusMiddle")}${deflate}${t("lazyMiddle")}${lazy}`;
		}

		/**
		 * 一行设置。
		 *
		 * @param field - 配置字段名。
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
		 * 只依赖宿主注入的 `useConfig` / `setField`：输入框非受控，失焦（或回车）提交，
		 * 配置回写后 key 变化会以新值重挂。
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

			/** 数字行。 */
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

			/** 开关行。 */
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

			/** 恢复默认。 */
			const reset = () => {
				let chain = Promise.resolve();
				for (const field of FIELD_ORDER) {
					chain = chain
						.then(() => {
							try {
								return setField(field, DEFAULTS[field]);
							} catch {
								return undefined;
							}
						})
						.catch(() => undefined);
				}
			};

			return h(
				"div",
				{ className: "dsh-slt-section" },
				h("h2", { className: "dsh-slt-title" }, t("title")),
				h("p", { className: "dsh-slt-intro" }, t("intro")),
				ready === true ? null : h("p", { className: "dsh-slt-note", "data-state": "unavailable" }, t("unavailable")),
				h("p", { className: "dsh-slt-status", "data-state": "active" }, statusText(t, value)),
				h(
					"div",
					{ className: "dsh-slt-rows" },
					numberRow("maxMessages", "messages"),
					switchRow("lazyLoad"),
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
				const snapshot = form?.getSnapshot?.();
				const value = snapshot?.value;
				return value !== null && typeof value === "object" ? value : undefined;
			};

			// send 钩子创建共享的原型状态，fetch 与懒加载挂在同一份状态上。
			installSendHook(readConfig);
			installFetchHook(readConfig);
			installAutoLoad(readConfig);

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
		exports.__rewritePageBody = rewritePageBody;
		exports.__shouldPrefetch = shouldPrefetch;
		exports.__installSendHook = installSendHook;
		exports.__installFetchHook = installFetchHook;
		exports.__installAutoLoad = installAutoLoad;
		exports.__Section = SessionLoadSection;
		exports.__defaults = DEFAULTS;
		exports.__ranges = RANGES;
		exports.__dictionaries = { zh, en };
		return module.exports;
	},
});
