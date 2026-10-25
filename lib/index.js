/**
 * dsh-session-load-tuner — 宿主半边。
 *
 * 这个插件做两件事，都不需要修改 dsh 自身的文件（升级不会被覆盖）：
 *
 *   1. 声明一组 volatile 配置，设置文档会把它们服务给浏览器，浏览器半边据此
 *      改写「载入历史」时发出的 `session/follow` 请求（原生窗口是硬编码的
 *      500 条消息，长会话一页就是 0.2–1.8 MB）。
 *
 *   2. 可选的 WebSocket 压缩：dsH 网关的 `WebSocketServer` 是用
 *      `{ noServer: true }` 建的，`ws` 默认不启用 permessage-deflate，所以
 *      /api/remote.mux 上那 1.8 MB 的 JSON 是原样发的。`ws` 的服务端在每次
 *      upgrade 时才读 `this.options.perMessageDeflate`（见 ws/lib/
 *      websocket-server.js 的 handleUpgrade），因此在
 *      `WebSocketServer.prototype.handleUpgrade` 上挂一个薄包装、在调用原函数
 *      前改这个字段，就能在不重启、不改厂商文件的前提下开关压缩。
 *
 * 压缩是否真的生效还取决于链路上有没有人吃掉扩展协商（本部署前面有
 * Cloudflare 和 Cloudflare Access）。没协商成功时连接仍按未压缩工作，不会坏；
 * 验证方法是看 WS 握手响应头里有没有 `Sec-WebSocket-Extensions`。
 *
 * 范围：这个包的边界是「Web GUI 发出去的字节」。当前两个杠杆（历史首屏窗口 +
 * WebSocket 压缩），往上滚的 session/page 翻页、图片附件在路线里；服务端性能
 * 和网络线路不归它管。
 *
 * 没有“启用”开关：停用插件本身就是开关——在「设置 → 插件」里停用这一条（或
 * 在 cordis.patch.yml 里给该条 `disabled: true`），浏览器半边就不再被加载，
 * 行为完全回到 dsh 原生。
 *
 * @module dsh-session-load-tuner
 */

import z from "@deepseek-ai/schemastery";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

/** 插件诊断名（也是 bundle patch 里的条目 id）。 */
export const name = "session-load-tuner";

/** 与浏览器半边共用的配置命名空间：等于宿主条目 id。 */
export const NAMESPACE = "session-load-tuner";

/**
 * 活跃配置。字段全部 volatile：设置文档实时服务这些值，浏览器半边每次发帧前
 * 读取，因此窗口参数改完刷新页面即可生效。
 */
export const Config = z.object({
	/** 打开会话时载入多少条消息。原生常量是 500；调小可显著减少跨境传输体积。 */
	maxMessages: z.number().step(1).min(20).max(500).default(120).volatile()
		.description("打开会话时载入的消息条数（替代原生 500）"),
	/** 滚到接近顶部时自动拉上一页（不用点「加载更早」）。 */
	lazyLoad: z.boolean().default(true).volatile()
		.description("滚到接近顶部时自动加载上一页（懒加载）"),
	/** 给 /api/remote.mux 开 permessage-deflate。只影响新建立的 WebSocket。 */
	wsDeflate: z.boolean().default(false).volatile()
		.description("WebSocket 压缩开关（permessage-deflate，新连接生效）"),
	/** 小于该字节数的帧不压缩，避免小帧白烧 CPU。 */
	wsDeflateThreshold: z.number().step(1).min(0).default(1024).volatile()
		.description("压缩阈值（字节），更小的帧不压缩"),
});

/** 挂在 ws 原型上的共享状态标记，防止重复包装。 */
const HOOK = Symbol.for("dsh.session-load-tuner.deflate-hook");

/** 本插件进程内的状态。 */
const state = {
	/** 最新的配置对象（cordis 重新 apply 时会替换）。 */
	config: {},
	/** 是否已经成功包装过 ws 原型。 */
	installed: false,
};

/**
 * 找到网关实际加载的那一份 `ws` 模块。
 *
 * 必须与 dsh-api-gateway 解析到同一个文件，否则拿到的是另一个模块实例，包装
 * 不到它的 WebSocketServer。优先从进程入口（dsh 的 lib/bin.js）解析，再退回
 * 常见全局安装路径。
 *
 * @returns 解析结果，找不到时为 undefined。
 */
function resolveWsModule() {
	const candidates = [];
	const entry = process.argv[1];
	if (typeof entry === "string" && entry.length > 0 && existsSync(entry)) {
		try {
			candidates.push(createRequire(entry).resolve("ws"));
		} catch {
			/* 入口旁边没有 ws 就继续尝试下一个候选 */
		}
	}
	for (const anchor of ["/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"]) {
		if (!existsSync(anchor)) continue;
		try {
			candidates.push(createRequire(anchor).resolve("ws"));
		} catch {
			/* 忽略：这个安装位置没有 ws */
		}
	}
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		try {
			return { file, require: createRequire(file) };
		} catch {
			/* 忽略：文件存在但 require 失败 */
		}
	}
	return undefined;
}

/**
 * 包装 `WebSocketServer.prototype.handleUpgrade`，让压缩开关在每次 upgrade 时
 * 读取最新配置。
 *
 * `ws` 在 handleUpgrade 内部才读 `this.options.perMessageDeflate` 做扩展协商，
 * 因此这里改字段即可；关掉时写回 `false`，新连接回到未压缩。
 *
 * @param ctx - 宿主插件上下文（可能没有 logger，按可选处理）。
 */
function installDeflateHook(ctx) {
	const found = resolveWsModule();
	if (found === undefined) {
		state.installed = false;
		ctx?.logger?.warn?.("session-load-tuner: 找不到 dsh 加载的 ws 模块，压缩开关不会生效");
		return;
	}
	let server;
	try {
		server = found.require(found.file);
	} catch (error) {
		state.installed = false;
		ctx?.logger?.warn?.(`session-load-tuner: 加载 ws 失败（${String(error)}），压缩开关不会生效`);
		return;
	}
	const proto = server?.WebSocketServer?.prototype;
	if (proto === undefined) {
		state.installed = false;
		return;
	}
	if (proto[HOOK] === undefined) {
		const original = proto.handleUpgrade;
		/** 每次 upgrade 前按当前配置设置 perMessageDeflate。 */
		proto[HOOK] = { config: state.config };
		proto.handleUpgrade = function handleUpgrade(request, socket, head, callback) {
			try {
				const config = proto[HOOK]?.config ?? {};
				if (this.options !== undefined) {
					if (config.wsDeflate === true) {
						const threshold = Number(config.wsDeflateThreshold);
						this.options.perMessageDeflate = {
							threshold: Number.isFinite(threshold) && threshold >= 0 ? Math.trunc(threshold) : 1024,
						};
					} else {
						this.options.perMessageDeflate = false;
					}
				}
			} catch {
				/* 包装本身绝不能影响升级流程 */
			}
			return original.call(this, request, socket, head, callback);
		};
	}
	proto[HOOK].config = state.config;
	state.installed = true;
}

/**
 * 宿主插件入口。
 *
 * @param ctx - cordis 宿主上下文。
 * @param config - 本条的 Config。
 */
export function apply(ctx, config) {
	state.config = config ?? {};
	installDeflateHook(ctx);
}

/** 给测试用：暴露解析与安装结果。 */
export const __internal = {
	resolveWsModule,
	installDeflateHook,
	state,
};
