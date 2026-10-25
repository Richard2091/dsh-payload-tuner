/**
 * 浏览器半边测试：Module Loader 注册、纯改写函数、以及真实的 WebSocket.send 钩子。
 *
 * 运行：node test/client-hook.mjs
 */

import assert from 'node:assert/strict';

// —— 模拟页面环境：window.__ModuleLoader__ 注册表 + 一个假的 WebSocket ——
const registry = new Map();
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			registry.set(spec.id, spec);
		},
	},
};

class FakeWebSocket {
	constructor() {
		this.sent = [];
	}
	send(data) {
		this.sent.push(data);
	}
}
globalThis.WebSocket = FakeWebSocket;

await import('../lib/client.js');

const spec = registry.get('dsh-load-tuner');
assert.ok(spec, '客户端 bundle 应以 dsh-load-tuner 注册到 Module Loader');

const client = spec.factory((name) => {
	throw new Error(`客户端 bundle 不应 require 其它模块，却 require 了 ${name}`);
});

let pass = 0;
const check = (label, fn) => {
	try {
		fn();
		pass += 1;
		console.log(`  ok   ${label}`);
	} catch (error) {
		console.log(`  FAIL ${label} — ${error.message}`);
		process.exitCode = 1;
	}
};

/** 构造一条网关 follow open 帧。 */
const followFrame = () =>
	JSON.stringify({
		type: 'open',
		streamId: 'stream-1',
		endpoint: 'session/follow',
		payload: {
			args: {
				request: {
					address: { kind: 'session', sessionId: 'session-abc' },
					assistantStream: true,
					maxMessages: 500,
					turnWindow: { minMessages: 50, minTurns: 2 },
				},
			},
		},
	});

console.log('浏览器半边：');

check('注册了 apply 与 inject', () => {
	assert.equal(typeof client.apply, 'function');
	assert.deepEqual(client.inject, ['configForms']);
});

check('改写 maxMessages / turnWindow，保留 address 与 assistantStream', () => {
	const frame = JSON.parse(followFrame());
	assert.equal(client.__applyWindow(frame, { enabled: true, maxMessages: 120, minMessages: 24, minTurns: 2 }), true);
	const request = frame.payload.args.request;
	assert.equal(request.maxMessages, 120);
	assert.deepEqual(request.turnWindow, { minMessages: 24, minTurns: 2 });
	assert.deepEqual(request.address, { kind: 'session', sessionId: 'session-abc' });
	assert.equal(request.assistantStream, true);
});

check('minMessages 超过 maxMessages 时被夹到 maxMessages（服务端有这条约束）', () => {
	const frame = JSON.parse(followFrame());
	client.__applyWindow(frame, { enabled: true, maxMessages: 60, minMessages: 500, minTurns: 2 });
	assert.equal(frame.payload.args.request.maxMessages, 60);
	assert.equal(frame.payload.args.request.turnWindow.minMessages, 60);
});

check('maxMessages 越界时被夹到 20..500', () => {
	const low = JSON.parse(followFrame());
	client.__applyWindow(low, { maxMessages: 1 });
	assert.equal(low.payload.args.request.maxMessages, 20);

	const high = JSON.parse(followFrame());
	client.__applyWindow(high, { maxMessages: 99999 });
	assert.equal(high.payload.args.request.maxMessages, 500);
});

check('enabled:false 时不改写', () => {
	const frame = JSON.parse(followFrame());
	assert.equal(client.__applyWindow(frame, { enabled: false, maxMessages: 60 }), false);
	assert.equal(frame.payload.args.request.maxMessages, 500);
});

check('配置未就绪（undefined）时不改写，退回原生行为', () => {
	assert.equal(client.__applyWindow(JSON.parse(followFrame()), undefined), false);
	assert.equal(client.__rewriteFrame(followFrame(), () => undefined), undefined);
});

check('非 follow 帧一律不动', () => {
	const page = JSON.stringify({
		type: 'open',
		streamId: 'stream-2',
		endpoint: 'session/page',
		payload: { args: { request: { maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } } } },
	});
	assert.equal(client.__rewriteFrame(page, () => ({ maxMessages: 60 })), undefined);
});

check('畸形 JSON 不抛错、原样放行', () => {
	const broken = `{"type":"open","endpoint":"session/follow"` + 'x'.repeat(40);
	assert.equal(client.__rewriteFrame(broken, () => ({ maxMessages: 60 })), undefined);
});

check('小帧走快速路径（不解析、不改写）', () => {
	assert.equal(client.__rewriteFrame('{"a":1}', () => ({ maxMessages: 60 })), undefined);
});

check('send 钩子端到端：改写过 follow 帧，未改写的帧保持字节一致', () => {
	const form = {
		getSnapshot: () => ({ status: 'ready', value: { enabled: true, maxMessages: 90, minMessages: 30, minTurns: 3 } }),
	};
	client.apply({ configForms: { get: () => form } });
	const socket = new FakeWebSocket();
	socket.send(followFrame());
	assert.equal(JSON.parse(socket.sent[0]).payload.args.request.maxMessages, 90);

	const plain = JSON.stringify({ type: 'item', streamId: 'stream-1', value: { hello: 'world' } });
	socket.send(plain);
	assert.equal(socket.sent[1], plain, '非 follow 帧必须原样发送');
});

check('apply 重复调用不会给 send 套第二层', () => {
	const form = { getSnapshot: () => ({ value: { enabled: true, maxMessages: 42 } }) };
	client.apply({ configForms: { get: () => form } });
	client.apply({ configForms: { get: () => form } });
	const socket = new FakeWebSocket();
	socket.send(followFrame());
	assert.equal(socket.sent.length, 1);
	assert.equal(JSON.parse(socket.sent[0]).payload.args.request.maxMessages, 42);
});

console.log(`\n结果：${pass} 通过`);
process.exit(process.exitCode ?? 0);
