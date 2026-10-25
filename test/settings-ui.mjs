/**
 * 设置页测试：注册到 settings.section、字段渲染、提交/夹紧/恢复默认/只读态。
 *
 * 用假的 React（createElement 返回普通对象）直接调用页面组件，避免引入浏览器。
 *
 * 运行：node test/settings-ui.mjs
 */

import assert from 'node:assert/strict';

// —— 模拟页面环境 ——
const registry = new Map();
globalThis.window = {
	__ModuleLoader__: { load: (spec) => registry.set(spec.id, spec) },
};
globalThis.WebSocket = class {
	send() {}
};

await import('../lib/client.js');

const spec = registry.get('dsh-session-load-tuner');
assert.ok(spec, '客户端 bundle 应以 dsh-session-load-tuner 注册');

/** 收集子节点（展开数组、丢掉 null/false/undefined）。 */
const flatten = (children) => children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);

const ReactStub = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) }),
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

/** 深度优先找出所有满足条件的元素。 */
function findAll(node, predicate, found = []) {
	if (node === null || typeof node !== 'object') return found;
	if (node.props !== undefined && predicate(node)) found.push(node);
	for (const child of node.children ?? []) findAll(child, predicate, found);
	return found;
}

const byField = (tree, field) => findAll(tree, (node) => node.props['data-field'] === field)[0];
const byAction = (tree, action) => findAll(tree, (node) => node.props['data-action'] === action)[0];

/** 造一个 stub 上下文，返回注册结果、表单快照与写入记录。 */
function createHarness(options = {}) {
	const writes = [];
	const dictionaries = new Map();
	const snapshot = {
		status: options.status ?? 'ready',
		writable: options.writable ?? true,
		value: options.value ?? {
			maxMessages: 120,
			minMessages: 24,
			minTurns: 2,
			wsDeflate: false,
			wsDeflateThreshold: 1024,
		},
	};
	const form = {
		getSnapshot: () => snapshot,
		set: (field, value) => {
			writes.push([field, value]);
			snapshot.value = { ...snapshot.value, [field]: value };
			return Promise.resolve(true);
		},
	};
	const registered = [];
	const ctx = {
		configForms: { get: () => form, whileServed: (namespaces, register) => register() },
		slots: {
			inject: (name, register) => register(),
			register: (registration, component) => {
				registered.push({ registration, component });
				return () => {};
			},
		},
		locale: {
			register: (namespace, dict) => {
				dictionaries.set(namespace, dict);
				return () => dictionaries.delete(namespace);
			},
			bind: (namespace) => (key) => dictionaries.get(namespace)?.zh?.[key] ?? key,
		},
		effect: (fn) => fn(),
	};
	return { ctx, form, snapshot, writes, registered, dictionaries };
}

const setup = (options) => {
	const harness = createHarness(options);
	client.apply(harness.ctx);
	return harness;
};

const renderSection = (harness) => {
	const { component, registration } = harness.registered[0];
	const props = registration.inject();
	const t = harness.ctx.locale.bind('session-load-tuner');
	const useConfig = (selector) => selector(harness.form.getSnapshot());
	return component({ ...props, useConfig, t });
};

console.log('设置页：');

check('注册为 settings.section（id/顺序/文案命名空间正确）', () => {
	const harness = setup();
	assert.equal(harness.registered.length, 1);
	const { registration } = harness.registered[0];
	assert.equal(registration.name, 'settings.section');
	assert.equal(registration.id, 'session-load-tuner');
	assert.equal(registration.order, 6);
	assert.equal(registration.locale, 'session-load-tuner');
	assert.equal(registration.label(), '会话加载');
	assert.ok(harness.dictionaries.has('session-load-tuner'), '应注册中英文案');
});

check('渲染出 4 个数字输入 + 1 个开关 + 状态行', () => {
	const tree = renderSection(setup());
	const numeric = ['maxMessages', 'minMessages', 'minTurns', 'wsDeflateThreshold'].filter((field) => {
		const node = byField(tree, field);
		return node !== undefined && node.props.type === 'number';
	});
	const switches = ['wsDeflate'].filter((field) => {
		const node = byField(tree, field);
		return node !== undefined && node.props.type === 'checkbox';
	});
	assert.deepEqual(numeric, ['maxMessages', 'minMessages', 'minTurns', 'wsDeflateThreshold']);
	assert.deepEqual(switches, ['wsDeflate']);
	const status = findAll(tree, (node) => node.props['data-state'] === 'active')[0];
	assert.ok(status.children[0].includes('首屏 120'), `状态行应显示当前条数，实际：${status.children[0]}`);
	assert.ok(status.children[0].includes('压缩关闭'), `状态行应显示压缩状态，实际：${status.children[0]}`);
});

check('数字失焦提交：60 → setField("maxMessages", 60)', () => {
	const harness = setup();
	const tree = renderSection(harness);
	const input = byField(tree, 'maxMessages');
	const target = { value: '60' };
	input.props.onBlur({ currentTarget: target });
	assert.deepEqual(harness.writes, [['maxMessages', 60]]);
	assert.equal(target.value, '60', '合法输入应回显为提交值');
});

check('越界与非法输入被夹紧/回显', () => {
	const harness = setup();
	const tree = renderSection(harness);

	const low = byField(tree, 'maxMessages');
	const lowTarget = { value: '5' };
	low.props.onBlur({ currentTarget: lowTarget });
	assert.deepEqual(harness.writes.at(-1), ['maxMessages', 20]);

	const high = byField(tree, 'maxMessages');
	const highTarget = { value: '9999' };
	high.props.onBlur({ currentTarget: highTarget });
	assert.deepEqual(harness.writes.at(-1), ['maxMessages', 500]);

	const garbage = byField(tree, 'minTurns');
	const garbageTarget = { value: 'abc' };
	garbage.props.onBlur({ currentTarget: garbageTarget });
	assert.equal(harness.writes.length, 2, '非法输入不应写配置');
	assert.equal(garbageTarget.value, '2', '非法输入应回显当前值');
});

check('开关 change 即提交', () => {
	const harness = setup();
	const tree = renderSection(harness);
	byField(tree, 'wsDeflate').props.onChange({ currentTarget: { checked: true } });
	assert.deepEqual(harness.writes, [['wsDeflate', true]]);
});

check('恢复默认按顺序写回 6 个字段', async () => {
	const harness = setup({ value: { maxMessages: 400, minMessages: 50, minTurns: 9, wsDeflate: true, wsDeflateThreshold: 4096 } });
	const tree = renderSection(harness);
	byAction(tree, 'reset').props.onClick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(harness.writes.map(([field]) => field), [
		'maxMessages',
		'minMessages',
		'minTurns',
		'wsDeflate',
		'wsDeflateThreshold',
	]);
	assert.deepEqual(harness.writes, [
		['maxMessages', 120],
		['minMessages', 24],
		['minTurns', 2],
		['wsDeflate', false],
		['wsDeflateThreshold', 1024],
	]);
});

check('不可写时控件全部禁用', () => {
	const tree = renderSection(setup({ writable: false }));
	for (const field of ['maxMessages', 'minMessages', 'minTurns', 'wsDeflate', 'wsDeflateThreshold']) {
		assert.equal(byField(tree, field).props.disabled, true, `${field} 应禁用`);
	}
	assert.equal(byAction(tree, 'reset').props.disabled, true, '恢复默认应禁用');
});

check('配置未就绪时给出提示并禁用控件', () => {
	const tree = renderSection(setup({ status: 'loading', writable: undefined }));
	const note = findAll(tree, (node) => node.props['data-state'] === 'unavailable')[0];
	assert.ok(note, '应出现“配置暂不可用”提示');
	assert.equal(byField(tree, 'maxMessages').props.disabled, true);
});

check('中英文案都已注册（键集一致）', () => {
	const harness = setup();
	const dict = harness.dictionaries.get('session-load-tuner');
	assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort());
});

console.log(`\n结果：${pass} 通过`);
process.exit(process.exitCode ?? 0);
