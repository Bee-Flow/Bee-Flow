'use strict';

/**
 * custom_block on the server: what saving keeps of `props.block`, what the validator says,
 * which actions a block can run (and so which a public page offers), the save limits, and
 * the builder tool. The template vocabulary itself is tested where it lives
 * (shared/blockTemplate/blockTemplate.test.mjs); the browser side in agent-hub.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition } = require('../componentSpecs');
const { applyToolCall } = require('../builderTools');
const { nodeActionRefs } = require('../nodeActionRefs.mts');
const { resolvePublicSurface, buildPublicDefinition } = require('../publicAccess');
const { collectDataBindings } = require('../collectDataBindings');
const { cleanCustomBlock } = require('./blockShape.mts');
const { sanitizeBlockCss } = require('./blockCss.mts');
const { blockSaveLimits } = require('./blockLimits.mts');
const { blockActionRefs, templateEvents } = require('./blockRefs.mts');
const ops = require('../../shared/appDefinition/definitionOps.mjs');

const X = 'http://leak.example/x';
const ACTIONS = {
    act_pick0001: { kind: 'toast', message: 'picked' },
    act_other001: { kind: 'toast', message: 'other' },
    act_secret01: { kind: 'toast', message: 'secret' },
};
const blockNode = (block, id = 'cmp_block001') => ({ id, type: 'custom_block', props: block === undefined ? {} : { block } });
const heading = { id: 'cmp_head0001', type: 'heading', props: { text: 'Hi' } };

function app(nodes, extra = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Blocks' },
        screens: [{ id: 'scr_home0001', name: 'Home', sections: [{ id: 'sec_main0001', children: nodes }] }],
        actions: ACTIONS,
        ...extra,
    };
}
const canon = (def) => canonicalizeAppDefinition(structuredClone(def));
const firstBlock = (def) => def.screens[0].sections[0].children.find((n) => n.type === 'custom_block').props.block;
const findings = (def) => {
    const v = validateAppDefinition(def);
    return { errors: v.errors.map((e) => e.code), warnings: v.warnings.map((w) => w.code) };
};
const clean = (raw) => {
    const repairs = [];
    const value = cleanCustomBlock(raw, (code, path, message) => repairs.push({ code, path, message }), 'block');
    return { value, repairs, codes: repairs.map((r) => r.code) };
};

test('an app without a custom block keeps its schema version and its bytes', () => {
    const plain = canon(app([heading])).def;
    assert.equal(plain.schemaVersion, 2);
    assert.equal(JSON.stringify(canon(plain).def), JSON.stringify(plain));
    assert.equal(canon(app([heading, blockNode({ template: '<p>a</p>' })])).def.schemaVersion, 3);
});

test('saving keeps the vocabulary and says what it left out, with the template line', () => {
    const { value, repairs } = clean({
        template: `<div class="a">\n<script>fetch('${X}')</script>\n<p onclick="x()">{{ who }}</p>\n<link rel="prerender" href="${X}">\n</div>`,
        css: `p{color:red} @import url(${X}); a{background:url(${X})}`,
        inputs: { who: { kind: 'static', value: 'Ada' } },
        events: { pick: 'act_pick0001', later: null, empty: '' },
        extra: true,
    });
    assert.deepEqual(value, {
        template: '<div class="a">\n\n<p>{{ who }}</p>\n\n</div>',
        css: 'p{color:red} a{}',
        inputs: { who: { kind: 'static', value: 'Ada' } },
        events: { pick: 'act_pick0001', later: null, empty: null },
    });
    assert.deepEqual(repairs.filter((r) => r.path === 'block.template').map((r) => r.message.slice(0, 16)), ['Template line 2:', 'Template line 3:', 'Template line 4:']);
    assert.ok(repairs.some((r) => r.code === 'block.css' && r.message.includes('@import') && r.message.includes('outside address')));
    assert.ok(repairs.some((r) => r.code === 'block.key_unknown' && r.path === 'block.extra'));
    assert.ok(!JSON.stringify(value).includes('leak.example'));
    // What is stored is clean: cleaning it again repairs nothing and changes nothing.
    const again = clean(value);
    assert.deepEqual(again.value, value);
    assert.deepEqual(again.repairs, []);
});

test('names: an input or event needs a usable name, and item and index are the repeat\'s', () => {
    const { value, codes } = clean({ template: '', inputs: { ok: { kind: 'static', value: 1 }, 'not ok': { kind: 'static', value: 1 }, item: { kind: 'static', value: 1 }, index: { kind: 'static', value: 1 }, '9x': { kind: 'static', value: 1 }, noBinding: 5, noKind: { value: 1 } }, events: { 'a-b': 'act_pick0001', fine: 'act_pick0001', bad: 7 } });
    assert.deepEqual(Object.keys(value.inputs), ['ok']);
    assert.deepEqual(value.events, { fine: 'act_pick0001' });
    assert.equal(codes.filter((c) => c === 'block.name_invalid').length, 5);
    assert.equal(codes.filter((c) => c === 'block.entry_invalid').length, 3);
    assert.equal(clean('<p>').value, undefined);
    assert.deepEqual(clean({ template: 5, css: 5, inputs: [], events: 'x' }).value, { template: '' });
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`in${i}`, { kind: 'static', value: i }]));
    assert.equal(Object.keys(clean({ template: '', inputs: many }).value.inputs).length, 20);
});

test('the stylesheet of a block: inline images only, no string in an image function', () => {
    const css = '.a{color:var(--bf-primary)}\nhtml[data-appearance="dark"] .a{color:white}\n.b::before{content:"→"}\n.c{background:url(data:image/png;base64,AAAA)}';
    assert.deepEqual(sanitizeBlockCss(css), { css, removed: [] });
    for (const bad of [`.a{background:url(${X})}`, '.a{background:url(/api/me)}', '.a{background:url(asset:abc)}', `.a{background:image-set("${X}" 1x)}`, '.a{background:image-set("data:image/png;base64,AAAA" 1x)}', `@font-face{font-family:x;src:url(${X})}`, `@import "${X}";`]) {
        const result = sanitizeBlockCss(`${bad}\n.keep{color:red}`);
        assert.ok(result.css.endsWith('.keep{color:red}'), bad);
        for (const word of ['leak.example', '/api/me', 'asset:', 'image', 'url', '@']) assert.equal(result.css.includes(word), false, `${bad}: ${word}`);
        assert.ok(result.removed.length > 0, bad);
    }
    assert.equal(sanitizeBlockCss('.a{color:red}</style><p>').css.includes('</'), false);
});

test('the validator: a stored block that is not clean is an error, clean and wired is none', () => {
    const good = canon(app([blockNode({ template: '<p>{{ who }}</p><button data-emit="pick" data-value="who">Go</button>', inputs: { who: { kind: 'static', value: 'Ada' } }, events: { pick: 'act_pick0001' } })])).def;
    assert.deepEqual(validateAppDefinition(good).errors, []);
    // Bytes that never passed the canonicalizer (an import): every repair is an error.
    const dirty = structuredClone(good);
    firstBlock(dirty).template = `<p onclick="x()">{{ who }}</p><link rel="prerender" href="${X}">`;
    const report = validateAppDefinition(dirty).errors.filter((e) => e.code === 'prop.object_invalid');
    assert.equal(report.length, 2);
    assert.match(report[0].message, /Template line 1: <p>: the attribute onclick is left out/);
    assert.match(report[1].message, /<link> is not an element a block may hold/);
    // The same template in a different quoting is not canonical either.
    firstBlock(dirty).template = "<p class='a'>{{ who }}</p>";
    assert.deepEqual(validateAppDefinition(dirty).errors.map((e) => e.code), ['prop.object_invalid']);
});

test('the validator: what a template reads and raises against what the block declares', () => {
    const def = canon(app([blockNode({
        template: '<p data-each="rows as r">{{ r.name }} {{ index }} {{ missing }} {{ vars.x }}</p>\n<p>{{ broken( }}</p>\n<button data-emit="pick">a</button><button data-emit="nobody">b</button>',
        inputs: { rows: { kind: 'records', tableId: 'tbl_nope' }, bad: { kind: 'nonsense' } },
        events: { pick: 'act_missing1', idle: 'act_other001', later: null },
    })])).def;
    const v = validateAppDefinition(def);
    const byCode = (list, code) => list.filter((f) => f.code === code);
    assert.deepEqual(byCode(v.errors, 'custom_block.input_unknown').map((e) => e.message.split('"')[1]), ['missing', 'vars']);
    assert.match(byCode(v.errors, 'custom_block.formula_invalid')[0].message, /^Template line 2: \{\{ broken\( \}\}/);
    assert.equal(byCode(v.errors, 'event.action_unresolved').length, 1);
    assert.equal(byCode(v.errors, 'binding.kind_invalid').length, 1);
    assert.deepEqual(byCode(v.warnings, 'custom_block.event_undeclared').map((w) => w.message.split('"')[1]), ['nobody']);
    assert.deepEqual(byCode(v.warnings, 'custom_block.event_unused').map((w) => w.path.split('.').pop()), ['idle', 'later']);
    assert.deepEqual(findings(canon(app([blockNode(undefined)])).def).warnings.filter((c) => c.startsWith('custom_block')), ['custom_block.empty']);
});

test('a block runs an action only when the event is wired AND a control of the template raises it', () => {
    const block = { template: '<button data-emit="pick">a</button><a data-emit="later">b</a><p data-emit="other">no control</p><!-- data-emit="secret" -->', events: { pick: 'act_pick0001', other: 'act_other001', secret: 'act_secret01', later: null } };
    assert.deepEqual(templateEvents(block.template), ['pick', 'later']);
    assert.deepEqual(blockActionRefs(block), [{ actionId: 'act_pick0001', via: 'block.events.pick', label: 'pick' }]);
    assert.deepEqual(nodeActionRefs(blockNode(block)), [{ actionId: 'act_pick0001', via: 'block.events.pick', label: 'pick' }]);
    assert.deepEqual(nodeActionRefs({ type: 'heading', props: { block } }), []);
    assert.deepEqual(blockActionRefs(null), []);
    assert.deepEqual(blockActionRefs({ template: 5, events: { pick: 'act_pick0001' } }), []);
    // Unreachable: the two actions no control raises.
    const def = canon(app([blockNode(block)])).def;
    assert.deepEqual(validateAppDefinition(def).warnings.filter((w) => w.code === 'action.unreachable').map((w) => w.path), ['actions.act_other001', 'actions.act_secret01']);
});

test('a public page offers the actions of the blocks drawn on its screens, and no other', () => {
    const wired = { template: '<button data-emit="pick">a</button>', events: { pick: 'act_pick0001', ghost: 'act_secret01' } };
    const office = { template: '<button data-emit="other">b</button>', events: { other: 'act_other001' } };
    const def = canon({
        schemaVersion: 2, meta: { name: 'Two audiences' }, actions: ACTIONS,
        screens: [
            { id: 'scr_open0001', name: 'Open', sections: [{ id: 'sec_open0001', children: [blockNode(wired, 'cmp_open0001')] }] },
            { id: 'scr_back0001', name: 'Back office', sections: [{ id: 'sec_back0001', children: [blockNode(office, 'cmp_back0001')] }] },
        ],
        publicAccess: { entryScreenId: 'scr_open0001', screenIds: ['scr_open0001'] },
    }).def;
    const surface = resolvePublicSurface(def);
    assert.deepEqual([...surface.actionIds], ['act_pick0001']);
    const sent = buildPublicDefinition(def, surface);
    assert.deepEqual(Object.keys(sent.actions), ['act_pick0001']);
    assert.equal(sent.screens.length, 1);
    assert.equal(JSON.stringify(sent).includes('data-emit=\\"other\\"'), false);
});

test('the inputs of a block are data bindings like any other', () => {
    const def = canon(app([blockNode({ template: '<p data-each="rows">{{ item.name }}</p>', inputs: { rows: { kind: 'records', tableId: 'tbl_people01' }, title: { kind: 'static', value: 'x' } } })])).def;
    const bindings = collectDataBindings(def);
    assert.deepEqual(bindings.map((b) => [b.prop, b.binding.kind, b.binding.tableId]), [['block', 'records', 'tbl_people01']]);
});

test('the save limits come from the environment, a whole number each, 0 for none', () => {
    assert.deepEqual(blockSaveLimits({}), { maxChars: 60000, maxNodes: 3000, maxDepth: 32 });
    assert.deepEqual(blockSaveLimits({ STUDIO_APP_BLOCK_TEMPLATE_CHARS: '100', STUDIO_APP_BLOCK_NODES: '0', STUDIO_APP_BLOCK_DEPTH: 'x' }), { maxChars: 100, maxNodes: Infinity, maxDepth: 32 });
    const before = process.env.STUDIO_APP_BLOCK_TEMPLATE_CHARS;
    process.env.STUDIO_APP_BLOCK_TEMPLATE_CHARS = '10';
    try {
        const { value, codes } = clean({ template: '<p>longer than ten</p>' });
        assert.equal(value.template, '');
        assert.deepEqual(codes, ['template.too_long']);
    } finally {
        if (before === undefined) delete process.env.STUDIO_APP_BLOCK_TEMPLATE_CHARS; else process.env.STUDIO_APP_BLOCK_TEMPLATE_CHARS = before;
    }
});

test('app_edit_block writes the parts it is given and answers with what was stored', async () => {
    const wrap = { userId: 'u1', def: emptyDefinition('Blocks'), dataModel: { tables: [] }, datasetIds: [] };
    const parentId = wrap.def.screens[0].sections[0].id;
    const added = await applyToolCall('app_add_components', { parentId, components: [{ tempId: 'b', type: 'custom_block' }, { tempId: 'h', type: 'heading', props: { text: 'x' } }] }, wrap);
    assert.ok(!added.error, JSON.stringify(added));
    const id = added.ids.b;
    assert.match((await applyToolCall('app_edit_block', { nodeId: added.ids.h, template: '<p>a</p>' }, wrap)).error, /No custom_block/);
    assert.match((await applyToolCall('app_edit_block', { nodeId: id }, wrap)).error, /Pass at least one/);
    assert.match((await applyToolCall('app_edit_block', { nodeId: id, events: { pick: 'act_nope' } }, wrap)).error, /does not exist/);

    const first = await applyToolCall('app_edit_block', {
        nodeId: id,
        template: `<ul><li data-each="rows as r">{{ r.name }} {{ total }}</li></ul>\n<script>x()</script>\n<button data-emit="pick">Go</button>`,
        css: `li{color:red} a{background:url(${X})}`,
        inputs: { rows: { kind: 'static', value: [{ name: 'Ada' }] } },
        events: { pick: null },
    }, wrap);
    assert.ok(!first.error, JSON.stringify(first));
    assert.equal(first.block.template, '<ul><li data-each="rows as r">{{ r.name }} {{ total }}</li></ul>\n\n<button data-emit="pick">Go</button>');
    assert.equal(first.block.css, 'li{color:red} a{}');
    assert.ok(first._hints.some((h) => h.includes('Template line 2') && h.includes('<script>')));
    assert.ok(first._hints.some((h) => h.includes('stylesheet')));
    assert.deepEqual(first.problems, ['The template reads "total", which is not an input: add inputs.total with a binding.', 'A control raises "pick" but events.pick names no action yet.']);
    assert.equal(wrap.def.schemaVersion, 3);

    // A later call changes one part and leaves the others; null removes a part.
    const second = await applyToolCall('app_edit_block', { nodeId: id, inputs: { rows: { kind: 'static', value: [] }, total: { kind: 'static', value: 3 } }, css: null }, wrap);
    assert.ok(!second.error, JSON.stringify(second));
    const stored = ops.findNode(wrap.def, id).node.props.block;
    assert.deepEqual(Object.keys(stored), ['template', 'inputs', 'events']);
    assert.equal(stored.template, first.block.template);
    assert.deepEqual(second.problems, ['A control raises "pick" but events.pick names no action yet.']);
});
