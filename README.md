# dsh-session-load-tuner

把 DSH Web GUI 的**会话加载**调成适合慢链路的样子：进会话先只拉一屏最新的记录，其余按批次异步补齐，快滚到最上面之前提前预取；传输上能压就压。插件实现，**不改 dsh 自身任何文件**（升级不会覆盖）。

背景：服务端在美国、浏览器隔着 Cloudflare + Cloudflare Access，一次「载入历史…」要拉 0.2–1.8 MB 未压缩 JSON。服务端组装这页只要 30–650 ms，慢在路上——所以这个插件管两件事：**何时加载、加载多少**，以及**怎么传**。

## 现在能做什么（v0.5）

1. **设置页**：「设置 → 会话加载」里改六个参数——首屏条数、至少消息数、至少轮次、懒加载、压缩、压缩阈值，带「恢复默认」。写回的是 profile 里的配置，不用再手改 yml。页面里没有“启用”开关：**停用插件本身就是总开关**——在「设置 → 插件」里停用这一条，或在 `cordis.patch.yml` 里给该条加 `disabled: true`，浏览器半边就不再加载，行为完全回到 dsh 原生。
2. **首屏条数与轮次对齐**：dsh 客户端里 `HISTORY_PAGE_OPTIONS` 硬编码 `maxMessages: 500` + `turnWindow: { minMessages: 50, minTurns: 2 }`（跳转页是 200 条）。插件把 `session/follow` 与往上滚的 `session/page` 请求都换成配置值：条数上限、至少消息数、至少轮次。
3. **懒加载**：滚到接近顶部（800px）时自动触发一次「加载更早」，不用手动点按钮；关掉后只在你点按钮时加载。
4. **WebSocket 压缩开关**：网关的 `WebSocketServer` 是 `{ noServer: true }` 建的，`ws` 默认不开 permessage-deflate，`/api/remote.mux` 上那份 JSON 原样发。插件在 `WebSocketServer.prototype.handleUpgrade` 上挂薄包装，按配置在每次 upgrade 前设置 `this.options.perMessageDeflate`——不动厂商文件、不打补丁。

## 范围与路线

边界：**浏览器这一侧怎么把会话数据取回来、传多大**。凡是符合这个边界的可以往里加，不属于的不加。

| 状态 | 项 | 实现位置 | 说明 |
|---|---|---|---|
| 已做 | 历史首屏窗口 | 浏览器 | `session/follow` 的 `maxMessages` / `turnWindow` |
| 已做 | WebSocket 压缩 | 宿主 | `/api/remote.mux` 的 permessage-deflate，按帧大小阈值 |
| 规划 | 进入会话的异步分批 | 浏览器 | 首屏只要一屏，后台用 `session/page` 按批补齐剩余；批次数量、每批条数可配 |
| 规划 | 懒加载预取 | 浏览器 | 滚动到距顶 N 条/像素时提前拉上一页；总开关、预取量可配 |
| 规划 | 翻页窗口 | 浏览器 | `session/page`（原生 500/200 条）与跳转页（`JUMP_PAGE_OPTIONS`）也走同一套参数 |
| 规划 | 附件图片懒加载 | 浏览器 | 历史图片走 `/api/session/attachment`（实测单张约 390 KB），进视口才取 |
| 另立插件 | 轮询节流 | — | 后台请求调度（cost-meter 每 10 s、commandcode-goat 每 30 s 且一直 403），和“加载”不同层，不塞进这个包 |
| 不做 | 服务端性能 | — | 解压 journal、投影、渲染不归它管；机器内存/swap 问题也不在这里解决 |
| 不做 | 网络线路 | — | 直连源站、关掉 Cloudflare、换机器是部署决策，插件只能少传/晚传 |

规划项的实现方式和风险：

- **异步分批与懒加载**都靠浏览器半边完成——`session/page` 是普通 HTTP RPC，客户端插件可以自己发；首屏 `follow` 帧自带 cursor 和 `hasMore`，知道还剩多少。滚动位置需要监听聊天容器的 DOM（或找 `data-chat-following-tail` 之类的标记），**这部分依赖 dsh 的界面结构，升级大版本时可能要跟一下**。
- 已做的两项（窗口改写、压缩）不依赖 DOM，升级 dsh 不受影响。
- 参数会随功能增加而扩展（批次、预取、图片），都走同一份 schemastery Config，加字段即加配置项。

## 安装

```sh
sh install.sh                       # 备份 + 复制 + 软链 + 写 patch
systemctl restart dsh-web.service   # 你自己执行：重启会打断当前会话
```

安装脚本只动三处，都会先备份到 `~/.dsh-backup-<时间戳>/`：

1. `~/.dsh/profiles/web/plugins/dsh-session-load-tuner/`（插件包）
2. `~/.dsh/profiles/web/node_modules/dsh-session-load-tuner`（软链）
3. `~/.dsh/profiles/web/cordis.patch.yml`（末尾追加带标记的 `insert` 条目）

**注意**：以后在 profile 里跑 `pnpm install` 会清掉第 2 步的软链（和 AGENTS.md 里记的软链坑同源），重跑一次 `install.sh` 即可；第 3 步是幂等的，不会重复写入。

## 参数

两个入口等价：**设置 → 会话加载**（推荐，即时写回），或手改 `~/.dsh/profiles/web/cordis.patch.yml` 的 `session-load-tuner` 条目（改完要重启）。

总开关不在这里：用插件的启停（`设置 → 插件` 或该条目的 `disabled: true`）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxMessages` | `120` | 首屏条数上限（20–500；原生 500） |
| `minMessages` | `50` | 至少凑够多少条消息才允许在轮次开头截断（原生 50；1–500 且 ≤ `maxMessages`） |
| `minTurns` | `2` | 至少跨过多少个轮次起点（原生 2；1–50） |
| `lazyLoad` | `true` | 滚到接近顶部时自动拉上一页（懒加载） |
| `wsDeflate` | `false` | WebSocket 压缩开关（permessage-deflate） |
| `wsDeflateThreshold` | `1024` | 小于该字节数的帧不压缩 |

生效时机：

- 在设置页里改：写回后立即保存；窗口参数在**下次打开会话**时生效（当前会话刷新页面亦可）。
- `maxMessages` / `minMessages` / `minTurns` / `lazyLoad`：浏览器半边每次发帧/滚动前现读配置。
- `wsDeflate` / `wsDeflateThreshold`：只影响**新建立的** WebSocket 连接；改完重启 `dsh-web.service` 最干净。

## 数字的口径

服务端分页（`paginate()`）里只有两类事件计入条数：

- `user/message`（你输入的一条）
- `assistant/message`（助手的一条消息，且必须是 append 到当前 surface 的）

**工具调用、turn/step、进度、卡片等事件都不计数**。而一个轮次（turn）里助手可能连发多条 `assistant/message`（比如调完工具再输出一段），所以：

- “条”≠“轮”：一轮可能是 1 条，也可能是 5 条；官方默认 50 条 / 2 轮，就是“至少 50 条消息、至少跨 2 轮”。
- 页面大小最终落在 `[minMessages, maxMessages]`，且一般停在某个轮次开头；如果先撞上 `maxMessages`，就在那里截断（可能从轮次中间开始）。
- `minMessages` 必须 ≤ `maxMessages`，否则服务端直接 400；插件在发请求前会再夹一次。

## 验证

```sh
# 客户端 bundle 是否被宿主注册并在服务（loopback 请求，不需要公网 Host）
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 127.0.0.1:3080' \
  http://127.0.0.1:3080/plugins/dsh-session-load-tuner/client.js    # 期望 200
```

浏览器 DevTools：

- **窗口**：Network → WS → 点开会话，发出的 `open` 帧里 `maxMessages` 应该是 120 而不是 500。
- **压缩**：同一次握手，响应头里应有 `Sec-WebSocket-Extensions: permessage-deflate`，之后帧体积明显变小。
  如果响应头里没有这个扩展，说明中间链路（本部署是 Cloudflare + Cloudflare Access）没有透传扩展协商——此时连接仍按未压缩工作，不会坏，只是没收益。

## 已知边界

- 首屏（`session/follow`）和往上滚（`session/page`）都已按配置改写；懒加载靠观察滚动 + 点「加载更早」按钮实现，**依赖聊天界面结构**（按钮文案是「加载更早 / Load earlier」，距顶阈值 800px），dsh 大版本升级可能要跟一下。
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
node test/client-hook.mjs   # 浏览器半边：帧/翻页改写、懒加载触发、钩子幂等
node test/settings-ui.mjs   # 设置页：注册、渲染、提交/夹紧/恢复默认/只读态
```

`lib/index.js` 是宿主半边（Config + ws 压缩钩子），`lib/client.js` 是浏览器半边（Module Loader 包，只做帧改写），`test/` 里是两边的测试。

MIT License。
