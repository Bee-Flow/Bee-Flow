'use strict';

/**
 * react_block on the server: what saving keeps of `props.block` (customBlock/reactBlockShape.mts),
 * the compile on save by app_edit_react_block (compile errors are reported), what the validator
 * says, and which actions a block can run. The sealed frame it is drawn in is tested in agent-hub
 * (…/runtime/components/reactBlock/).
 */

const { cleanReactBlock, sourceStamp } = require('./reactBlockShape.mts');
const ops = require('../../shared/appDefinition/definitionOps.mjs');
const { applyToolCall } = require('../builderTools');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { emptyDefinition } = require('../componentSpecs');
const { nodeActionRefs } = require('../nodeActionRefs.mts');
const { validateAppDefinition } = require('../validate');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const COUNTER = "import { useState } from 'react';\nexport default function Counter({ start, emit }) {\n  const [n, setN] = useState(start ?? 0);\n  return <button onClick={() => { setN(n + 1); emit('pick', n + 1); }}>{n}</button>;\n}\n";

function collect() {
    const found = [];
    return { found, push: (code, path, message) => found.push({ code, path, message }) };
}

async function withBlock() {
    const wrap = { userId: 'u1', def: emptyDefinition('React'), dataModel: { tables: [] }, datasetIds: [] };
    wrap.def.actions = { act_pick0001: { kind: 'toast', message: 'picked' } };
    const parentId = wrap.def.screens[0].sections[0].id;
    const added = await applyToolCall('app_add_components', { parentId, components: [{ tempId: 'r', type: 'react_block' }, { tempId: 'h', type: 'heading', props: { text: 'x' } }] }, wrap);
    assert.ok(!added.error, JSON.stringify(added));
    return { wrap, id: added.ids.r, headingId: added.ids.h };
}

test('the cleaner keeps a compile outcome only for the source it belongs to', () => {
    const { found, push } = collect();
    const fresh = cleanReactBlock({ source: COUNTER, compiled: 'module.exports={}', compiledFor: sourceStamp(COUNTER), bogus: 1 }, push, 'b');
    assert.deepEqual(Object.keys(fresh), ['source', 'compiled', 'compiledFor']);
    assert.deepEqual(found.map((f) => f.code), ['block.key_unknown']);

    const stale = collect();
    const out = cleanReactBlock({ source: `${COUNTER}// changed`, compiled: 'module.exports={}', compiledFor: sourceStamp(COUNTER) }, stale.push, 'b');
    assert.deepEqual(Object.keys(out), ['source']);
    assert.deepEqual(stale.found.map((f) => f.code), ['block.stale_compile']);
});

test('the cleaner refuses inputs named like the props the frame gives itself, and keeps css, inputs and events like a custom block', () => {
    const { found, push } = collect();
    const out = cleanReactBlock({
        source: COUNTER,
        css: 'p{color:red} a{background:url(http://leak.example/x)}',
        inputs: { emit: { kind: 'static', value: 1 }, start: { kind: 'static', value: 2 } },
        events: { pick: 'act_pick0001' },
    }, push, 'b');
    assert.deepEqual(out.inputs, { start: { kind: 'static', value: 2 } });
    assert.deepEqual(out.events, { pick: 'act_pick0001' });
    assert.equal(out.css, 'p{color:red} a{}');
    assert.ok(found.some((f) => f.code === 'block.name_invalid' && f.path === 'b.inputs.emit'));
});

test('app_edit_react_block compiles on save and reports a compile error with diagnostics', async () => {
    const { wrap, id, headingId } = await withBlock();
    assert.match((await applyToolCall('app_edit_react_block', { nodeId: headingId, source: COUNTER }, wrap)).error, /No react_block/);
    assert.match((await applyToolCall('app_edit_react_block', { nodeId: id }, wrap)).error, /Pass at least one/);
    assert.match((await applyToolCall('app_edit_react_block', { nodeId: id, source: 'x', sourceEdits: [{ find: 'x', replace: 'y' }] }, wrap)).error, /not both/);
    assert.match((await applyToolCall('app_edit_react_block', { nodeId: id, events: { pick: 'act_nope' } }, wrap)).error, /does not exist/);

    const broken = await applyToolCall('app_edit_react_block', { nodeId: id, source: 'export default function X() { return <div>; }' }, wrap);
    assert.ok(!broken.error, JSON.stringify(broken));
    assert.equal(broken.compiled, false);
    assert.match(broken.compileError, /component\.tsx:1:/);
    assert.ok(broken.diagnostics.length > 0 && broken.diagnostics[0].line === 1);
    const v1 = validateAppDefinition(wrap.def, { tables: [] });
    assert.ok(v1.errors.some((e) => e.code === 'react_block.not_compiled'), JSON.stringify(v1.errors));

    const imports = await applyToolCall('app_edit_react_block', { nodeId: id, source: "import x from 'lodash';\nexport default function X() { return <p>{x}</p>; }" }, wrap);
    assert.equal(imports.compiled, false);
    assert.match(imports.compileError, /may import only: react/);

    const ok = await applyToolCall('app_edit_react_block', {
        nodeId: id, source: COUNTER, inputs: { start: { kind: 'static', value: 3 } }, events: { pick: 'act_pick0001' },
    }, wrap);
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.equal(ok.compiled, true);
    assert.equal(ok.compileError, '');
    assert.match(ok.block.compiled, /^<\d+ characters>$/);
    const stored = ops.findNode(wrap.def, id).node.props.block;
    assert.equal(stored.compiledFor, sourceStamp(COUNTER));
    assert.match(stored.compiled, /require\("react"\)|require\('react'\)/);
    assert.equal(wrap.def.schemaVersion, 3);
    const v2 = validateAppDefinition(wrap.def, { tables: [] });
    assert.ok(!v2.errors.some((e) => e.path.includes('props.block')), JSON.stringify(v2.errors));

    // sourceEdits change the stored source and compile again; a find that is not there saves nothing.
    const edited = await applyToolCall('app_edit_react_block', { nodeId: id, sourceEdits: [{ find: 'n + 1); emit', replace: 'n + 2); emit' }] }, wrap);
    assert.equal(edited.compiled, true);
    assert.match(ops.findNode(wrap.def, id).node.props.block.source, /n \+ 2\); emit/);
    const missing = await applyToolCall('app_edit_react_block', { nodeId: id, sourceEdits: [{ find: 'nowhere', replace: '' }] }, wrap);
    assert.match(missing.error, /not found/);
});

test('a source changed by another tool loses its compile outcome, and the validator says so', async () => {
    const { wrap, id } = await withBlock();
    await applyToolCall('app_edit_react_block', { nodeId: id, source: COUNTER }, wrap);
    const before = ops.findNode(wrap.def, id).node.props.block;
    const def = canonicalizeAppDefinition(ops.updateNodeProps(structuredClone(wrap.def), id, { block: { ...before, source: `${COUNTER}\n// edited elsewhere` } })).def;
    const block = ops.findNode(def, id).node.props.block;
    assert.equal(block.compiled, undefined);
    assert.ok(validateAppDefinition(def, { tables: [] }).errors.some((e) => e.code === 'react_block.not_compiled'));
});

test('every wired event of a react_block counts as an action the node runs', () => {
    const node = { id: 'cmp_react001', type: 'react_block', props: { block: { source: COUNTER, events: { pick: 'act_pick0001', later: null } } } };
    assert.deepEqual(nodeActionRefs(node), [{ actionId: 'act_pick0001', via: 'block.events.pick', label: 'pick' }]);
});
