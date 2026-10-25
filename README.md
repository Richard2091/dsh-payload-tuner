# dsh-payload-tuner

把 DSH Web GUI 在**慢链路**上要传的东西调小。插件实现，**不改 dsh 自身任何文件**（升级不会覆盖）。

针对的问题很具体：服务端在美国、浏览器隔着 Cloudflare + Cloudflare Access，一次「载入历史…」就要拉 0.2–1.8 MB 未压缩 JSON，点哪个会话都慢。服务端组装这页其实只要 30–650 ms，慢在路上——所以这个插件的战场是**载荷**，不是服务端性能。

## 现在能做什么（v0.1）

1. **历史首屏窗口可配**：dsh 客户端里 `HISTORY_PAGE_OPTIONS` 硬编码 `maxMessages: 500` / `minMessages: 50`。插件在浏览器里拦下 `session/follow` 的 open 帧，换成配置的大小（默认 120 条），往上滚仍能继续加载更早内容。
2. **WebSocket 压缩开关**：网关的 `WebSocketServer` 是 `{ noServer: true }` 建的，`ws` 默认不开 permessage-deflate，`/api/remote.mux` 上那份 JSON 原样发。插件在 `WebSocketServer.prototype.handleUpgrade` 上挂薄包装，按配置在每次 upgrade 前设置 `this.options.perMessageDeflate`——不动厂商文件、不打补丁。

## 范围与路线

这插件的边界是「**Web GUI 发出去的字节**」，凡是符合这个边界的都能往里加，不属于的就不加：

| 状态 | 项 | 说明 |
|---|---|---|
| 已做 | 历史首屏窗口 | `session/follow` 的 `maxMessages` / `turnWindow` |
| 已做 | WebSocket 压缩 | `/api/remote.mux` 的 permessage-deflate，按帧大小阈值 |
| 待做 | 翻页窗口 | 往上滚的 `session/page`（HTTP，原生 500/200 条）和跳转页（`JUMP_PAGE_OPTIONS` minMessages 200） |
| 待做 | 附件与图片 | 历史里的图片走 `/api/session/attachment`（实测单张约 390 KB），按需懒加载 / 限尺寸 |
| 待做 | 轮询降频 | cost-meter 每 10 s、commandcode-goat 每 30 s（且一直 403）的高频小请求，合并或降频 |
| 不做 | 服务端性能 | 解压 journal、投影、渲染都不是它的活；机器内存/swap 问题也不在这里解决 |
| 不做 | 网络线路 | 直连源站、关掉 Cloudflare、换机器——这些是部署决策，插件只能少传数据 |

命名就是这个意思：不是 `dsh-history-window`（只覆盖一块），而是 `dsh-payload-tuner`（覆盖「少传」这一类）；当前的 v0.1 只是其中两个最省事的杠杆。

## 安装

```sh
sh install.sh                       # 备份 + 复制 + 软链 + 写 patch
systemctl restart dsh-web.service   # 你自己执行：重启会打断当前会话
```

安装脚本只动三处，都会先备份到 `~/.dsh-backup-<时间戳>/`：

1. `~/.dsh/profiles/web/plugins/dsh-payload-tuner/`（插件包）
2. `~/.dsh/profiles/web/node_modules/dsh-payload-tuner`（软链）
3. `~/.dsh/profiles/web/cordis.patch.yml`（末尾追加带标记的 `insert` 条目）

**注意**：以后在 profile 里跑 `pnpm install` 会清掉第 2 步的软链（和 AGENTS.md 里记的软链坑同源），重跑一次 `install.sh` 即可；第 3 步是幂等的，不会重复写入。

## 参数

都在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `payload-tuner` 条目里：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉后浏览器半边不碰任何请求 |
| `maxMessages` | `120` | 首屏消息条数上限（20–500；原生 500） |
| `minMessages` | `24` | 首屏至少覆盖的消息数（原生 50，服务端要求 ≤ `maxMessages`） |
| `minTurns` | `2` | 首屏至少覆盖的轮次数 |
| `wsDeflate` | `false` | WebSocket 压缩开关（permessage-deflate） |
| `wsDeflateThreshold` | `1024` | 小于该字节数的帧不压缩 |

生效时机：

- `maxMessages` / `minMessages` / `minTurns` / `enabled`：**刷新页面**即生效（浏览器半边每次发帧前现读配置）。
- `wsDeflate` / `wsDeflateThreshold`：只影响**新建立的** WebSocket 连接；改完重启 `dsh-web.service` 最干净。

## 验证

```sh
# 客户端 bundle 是否被宿主注册并在服务（loopback 请求，不需要公网 Host）
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 127.0.0.1:3080' \
  http://127.0.0.1:3080/plugins/dsh-payload-tuner/client.js    # 期望 200
```

浏览器 DevTools：

- **窗口**：Network → WS → 点开会话，发出的 `open` 帧里 `maxMessages` 应该是 120 而不是 500。
- **压缩**：同一次握手，响应头里应有 `Sec-WebSocket-Extensions: permessage-deflate`，之后帧体积明显变小。
  如果响应头里没有这个扩展，说明中间链路（本部署是 Cloudflare + Cloudflare Access）没有透传扩展协商——此时连接仍按未压缩工作，不会坏，只是没收益。

## 已知边界

- 只改写首屏 `session/follow`；往上滚的 `session/page` 走 HTTP，仍按原生 500/200 条（在路线里）。
- 页面刚启动、设置文档还没返回时，第一帧按**原生**窗口处理（插件不猜配置），之后的会话打开都用配置值。
- 不改 dsh 的 `ws` 包，也不 patch 网关源码：`ws` 服务端在 `handleUpgrade` 内部才做扩展协商，所以包装原型即可（见 `lib/index.js` 注释）。
- 参数由 schemastery 严格校验：写成 `maxMessages: 999` 会让条目加载失败，取值范围见上表。

## 卸载 / 回滚

```sh
sh uninstall.sh
systemctl restart dsh-web.service
```

卸载删掉 patch 块、软链和插件目录，并把 patch 备份到 `~/.dsh-backup-<时间戳>/`。彻底回滚也可以直接用备份里的 `cordis.patch.yml` 覆盖回去。

## 开发

```sh
# 测试依赖 profile 里的 @deepseek-ai/schemastery 和 dsh 安装目录里的 ws
ln -s ~/.dsh/profiles/web/node_modules node_modules   # 仅本地跑测试用，已 gitignore

node test/deflate.mjs       # 宿主半边：压缩协商在 开/关 之间来回切换
node test/client-hook.mjs   # 浏览器半边：帧改写、边界值、畸形输入、幂等
```

`lib/index.js` 是宿主半边（Config + ws 压缩钩子），`lib/client.js` 是浏览器半边（Module Loader 包，只做帧改写），`test/` 里是两边的测试。

MIT License。
