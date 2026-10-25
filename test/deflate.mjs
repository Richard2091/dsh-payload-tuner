/**
 * 宿主半边测试：确认包装 `WebSocketServer.prototype.handleUpgrade` 之后，
 * 一个原本没开压缩的 `ws` 服务能在开关之间来回切换协商（新连接生效）。
 *
 * 运行：node test/deflate.mjs
 */

import http from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { apply, __internal } from '../lib/index.js';

const wsPath = __internal.resolveWsModule();
if (wsPath === undefined) throw new Error('找不到 dsh 加载的 ws 模块');
const ws = createRequire(wsPath.file)(wsPath.file);
const { WebSocketServer, WebSocket } = ws;

// 模拟 DSH 网关：noServer、默认不开压缩。
const server = new WebSocketServer({ noServer: true });
let pass = 0;
let fail = 0;
const check = (label, condition, detail) => {
	if (condition) {
		pass += 1;
		console.log(`  ok   ${label}`);
	} else {
		fail += 1;
		console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
	}
};

// 安装插件钩子（先关压缩）。
apply({}, { wsDeflate: false, wsDeflateThreshold: 1024 });

const httpServer = http.createServer((req, res) => res.end());
httpServer.on('upgrade', (request, socket, head) => {
	server.handleUpgrade(request, socket, head, (client) => {
		client.on('message', (message) => client.send(`echo:${message.toString()}`));
	});
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const port = httpServer.address().port;

function probe() {
	return new Promise((resolve) => {
		const client = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: true });
		let negotiated = null;
		client.on('upgrade', (response) => {
			negotiated = response.headers['sec-websocket-extensions'] ?? '(none)';
		});
		client.on('open', () => client.send('x'.repeat(4096)));
		client.on('message', (message) => {
			client.close();
			resolve({ negotiated, length: message.toString().length });
		});
		client.on('error', (error) => resolve({ negotiated, error: error.message }));
	});
}

console.log('宿主半边 deflate 钩子：');

apply({}, { wsDeflate: false });
let result = await probe();
check('开关关闭时不应协商压缩', result.negotiated === '(none)', `实际 ${result.negotiated}`);
check('未压缩时消息仍完整到达', result.length === 4096 + 'echo:'.length);

apply({}, { wsDeflate: true, wsDeflateThreshold: 1024 });
result = await probe();
check('开关打开后新连接协商 permessage-deflate', result.negotiated === 'permessage-deflate', `实际 ${result.negotiated}`);
check('压缩时解压后的消息仍完整到达', result.length === 4096 + 'echo:'.length);

apply({}, { wsDeflate: true, wsDeflateThreshold: 4096 });
result = await probe();
check('阈值大于帧长时仍协商扩展（阈值只影响是否压缩该帧）', result.negotiated === 'permessage-deflate');

apply({}, { wsDeflate: false });
result = await probe();
check('再次关闭后新连接回到未压缩', result.negotiated === '(none)', `实际 ${result.negotiated}`);

server.close();
httpServer.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
