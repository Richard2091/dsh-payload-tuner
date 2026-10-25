/**
 * 浏览器半边测试：帧改写、翻页请求改写、懒加载触发判定与钩子、幂等。
 *
 * 运行：node test/client-hook.mjs
 */

import assert from 'node:assert/strict';

// —— 模拟页面环境 ——
const registry = new Map();
globalThis.window = {
	__ModuleLoader__: { load: (spec) => registry.set(spec.id, spec) },
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

const spec = registry.get('dsh-session-load-tuner');
assert.ok(spec, '客户端 bundle 应以 dsh-session-load-tuner 注册');

const ReactStub = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
};
const client = spec.factory((name) => {
	if (name === 'react') return ReactStub;
	throw new Error(`客户端 bundle require 了未预期的模块：${name}`);
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
const checkAsync = async (label, fn) => {
	try {
		await fn();
		pass += 1;
		console.log(`  ok   ${label}`);
	} catch (error) {
		console.log(`  FAIL ${label} — ${error.message}`);
		process.exitCode = 1;
	}
};

/** 一条 follow open 帧（原生形态：500 条 + turnWindow）。 */
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

const CONFIG = { maxMessages: 120, lazyLoad: true, wsDeflate: false, wsDeflateThreshold: 1024 };
const readConfig = () => CONFIG;

console.log('浏览器半边：');

check('注册了 apply 与 inject', () => {
	assert.equal(typeof client.apply, 'function');
	assert.deepEqual(client.inject, ['configForms', 'slots', 'locale']);
});

check('follow 帧：maxMessages 换成配置值，turnWindow 被去掉', () => {
	const frame = JSON.parse(followFrame());
	assert.equal(client.__applyWindow(frame, CONFIG), true);
	const request = frame.payload.args.request;
	assert.equal(request.maxMessages, 120);
	assert.equal('turnWindow' in request, false, 'turnWindow 应被删除，条数才可预期');
	assert.deepEqual(request.address, { kind: 'session', sessionId: 'session-abc' });
	assert.equal(request.assistantStream, true);
});

check('maxMessages 越界时夹到 20..500', () => {
	const low = JSON.parse(followFrame());
	client.__applyWindow(low, { maxMessages: 1 });
	assert.equal(low.payload.args.request.maxMessages, 20);

	const high = JSON.parse(followFrame());
	client.__applyWindow(high, { maxMessages: 99999 });
	assert.equal(high.payload.args.request.maxMessages, 500);
});

check('配置未就绪（undefined）时不改写', () => {
	assert.equal(client.__applyWindow(JSON.parse(followFrame()), undefined), false);
	assert.equal(client.__rewriteFrame(followFrame(), () => undefined), undefined);
});

check('非 follow 帧一律不动', () => {
	const page = JSON.stringify({
		type: 'open',
		streamId: 'stream-2',
		endpoint: 'session/page',
		payload: { args: { request: { maxMessages: 500 } } },
	});
	assert.equal(client.__rewriteFrame(page, readConfig), undefined);
});

check('畸形 JSON 不抛错、原样放行', () => {
	const broken = `{"type":"open","endpoint":"session/follow"` + 'x'.repeat(40);
	assert.equal(client.__rewriteFrame(broken, readConfig), undefined);
});

check('send 钩子端到端：follow 帧被改写，其它帧字节一致', () => {
	client.__installSendHook(readConfig);
	const socket = new FakeWebSocket();
	socket.send(followFrame());
	assert.equal(JSON.parse(socket.sent[0]).payload.args.request.maxMessages, 120);

	const plain = JSON.stringify({ type: 'item', streamId: 'stream-1', value: { hello: 'world' } });
	socket.send(plain);
	assert.equal(socket.sent[1], plain);
});

check('翻页请求体：同样换成配置条数并去掉 turnWindow', () => {
	const body = JSON.stringify({
		args: {
			request: {
				address: { kind: 'session', sessionId: 'session-abc' },
				throughSeq: 100,
				maxMessages: 500,
				turnWindow: { minMessages: 200, minTurns: 2 },
			},
		},
	});
	const rewritten = JSON.parse(client.__rewritePageBody(body, CONFIG));
	assert.equal(rewritten.args.request.maxMessages, 120);
	assert.equal('turnWindow' in rewritten.args.request, false);
	assert.equal(rewritten.args.request.throughSeq, 100);

	assert.equal(client.__rewritePageBody('not json', CONFIG), undefined);
	assert.equal(client.__rewritePageBody(JSON.stringify({ args: {} }), CONFIG), undefined);
	assert.equal(client.__rewritePageBody(body, undefined), undefined);
});

check('懒加载触发判定：接近顶部才触发', () => {
	assert.equal(client.__shouldPrefetch({ scrollTop: 100, scrollHeight: 5000, clientHeight: 800 }), true);
	assert.equal(client.__shouldPrefetch({ scrollTop: 799, scrollHeight: 5000, clientHeight: 800 }), true);
	assert.equal(client.__shouldPrefetch({ scrollTop: 2000, scrollHeight: 5000, clientHeight: 800 }), false);
	assert.equal(client.__shouldPrefetch({ scrollTop: 0, scrollHeight: 600, clientHeight: 800 }), false, '内容不足一屏时没有“更早”可加载');
	assert.equal(client.__shouldPrefetch({}), false);
	assert.equal(client.__shouldPrefetch(undefined), false);
});

check('fetch 钩子：只改 /api/session/page，其它请求原样', () => {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = (input, init) => {
		calls.push({ input, init });
		return Promise.resolve({ ok: true });
	};
	try {
		client.__installFetchHook(readConfig);
		const body = JSON.stringify({ args: { request: { maxMessages: 500, turnWindow: { minMessages: 200, minTurns: 2 } } } });
		void globalThis.fetch('/api/session/page', { method: 'POST', body });
		void globalThis.fetch('/api/session/list', { method: 'POST', body: '{}' });
		assert.equal(calls.length, 2);
		const rewritten = JSON.parse(calls[0].init.body);
		assert.equal(rewritten.args.request.maxMessages, 120);
		assert.equal('turnWindow' in rewritten.args.request, false);
		assert.equal(calls[1].init.body, '{}');
	} finally {
		globalThis.fetch = original;
	}
});

await checkAsync('懒加载：滚到顶部附近自动点「加载更早」，关闭后不点', async () => {
	const listeners = [];
	const clicked = [];
	const flow = {
		querySelectorAll: () => [{ disabled: false, textContent: ' 加载更早 ', click: () => clicked.push(Date.now()) }],
	};
	const doc = {
		addEventListener: (type, handler) => listeners.push({ type, handler }),
		removeEventListener: () => {},
		querySelector: () => flow,
	};
	const scroller = { scrollTop: 200, scrollHeight: 5000, clientHeight: 800, contains: () => true };

	client.__installAutoLoad(readConfig, doc);
	assert.equal(listeners.length, 1, '应在 document 上挂一个 scroll 监听');
	listeners[0].handler({ target: scroller });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(clicked.length, 1, '应自动点一次');

	listeners[0].handler({ target: scroller });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(clicked.length, 1, '冷却期内不应重复点');

	client.__installAutoLoad(() => ({ ...CONFIG, lazyLoad: false }), doc);
	await new Promise((resolve) => setTimeout(resolve, 850));
	listeners[0].handler({ target: scroller });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(clicked.length, 1, 'lazyLoad 关闭后不应再点');
});

await checkAsync('apply 重复调用不会给 send 套第二层', async () => {
	const form = { getSnapshot: () => ({ status: 'ready', writable: true, value: { maxMessages: 42 } }) };
	const ctx = {
		configForms: { get: () => form, whileServed: (ns, register) => register() },
		slots: { inject: (name, register) => register(), register: () => () => {} },
		locale: { register: () => () => {}, bind: () => (key) => key },
		effect: (fn) => fn(),
	};
	client.apply(ctx);
	client.apply(ctx);
	const socket = new FakeWebSocket();
	socket.send(followFrame());
	assert.equal(socket.sent.length, 1);
	assert.equal(JSON.parse(socket.sent[0]).payload.args.request.maxMessages, 42);
});

console.log(`\n结果：${pass} 通过`);
process.exit(process.exitCode ?? 0);
