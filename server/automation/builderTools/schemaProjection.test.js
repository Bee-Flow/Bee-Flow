/**
 * The lean schema projection: what the small band's menu may and may not
 * carry, and what the full variant must leave untouched.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/schemaProjection.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_SCHEMAS } = require('../builderTools');
const { CORE_TOOL_NAMES } = require('../builderModelProfiles');
const { buildFewShotMessages } = require('../builderPrompt');
const {
    projectToolSchemas, DROP_TOOLS_SMALL, LEAN_BATCH_TYPES, SET_METADATA_DESCRIPTION, UNRENDERED_KEYWORDS, _stripUnrenderedKeywords,
} = require('./schemaProjection');

// The menu chatStream.js hands to the projection for the small band.
const CORE = TOOL_SCHEMAS.filter(t => CORE_TOOL_NAMES.has(t.function.name));
const BEFORE = JSON.stringify(TOOL_SCHEMAS);
const lean = () => projectToolSchemas(CORE, { variant: 'lean' });
const leanTool = (n) => lean().find(t => t.function.name === n);

test('full is the identity: the same array and the same objects come back', () => {
    assert.equal(projectToolSchemas(CORE, { variant: 'full' }), CORE);
    assert.equal(projectToolSchemas(CORE), CORE, 'the default is full');
    for (const [i, t] of projectToolSchemas(CORE, { variant: 'full' }).entries()) assert.equal(t, CORE[i]);
});

test('lean never mutates TOOL_SCHEMAS (mcpBuilder and flowletAgent ship it verbatim)', () => {
    lean(); lean();
    assert.equal(JSON.stringify(TOOL_SCHEMAS), BEFORE);
    const t = leanTool('builder_add_action');
    assert.notEqual(t, CORE.find(x => x.function.name === 'builder_add_action'), 'a new object');
});

test('the small menu is the 22 core names minus the four dropped tools', () => {
    const names = lean().map(t => t.function.name);
    assert.equal(names.length, 22);
    for (const n of names) assert.ok(CORE_TOOL_NAMES.has(n), `${n} ⊆ core`);
    for (const n of DROP_TOOLS_SMALL) {
        assert.ok(CORE_TOOL_NAMES.has(n), `${n} stays in the ONE core list`);
        assert.ok(!names.includes(n), `${n} is dropped from the lean menu`);
    }
    assert.deepEqual([...new Set(names)].length, names.length, 'no duplicates');
});

test('every required list of the source survives, at every level', () => {
    const requiredPaths = (node, path, out) => {
        if (!node || typeof node !== 'object') return out;
        if (Array.isArray(node.required)) out.set(path, node.required.slice().sort());
        for (const [k, v] of Object.entries(node.properties || {})) requiredPaths(v, `${path}.${k}`, out);
        if (node.items) requiredPaths(node.items, `${path}[]`, out);
        return out;
    };
    for (const t of lean()) {
        const full = CORE.find(x => x.function.name === t.function.name);
        const before = requiredPaths(full.function.parameters, t.function.name, new Map());
        const after = requiredPaths(t.function.parameters, t.function.name, new Map());
        for (const [path, req] of before) {
            // A level the projection removed wholesale (a dropped property)
            // has no required list to keep; every level that exists keeps it.
            if (!after.has(path)) {
                const parent = path.replace(/\.[^.]+$|\[\]$/, '');
                assert.ok(!after.has(parent) || !propertyExists(t.function.parameters, path), `${path}: level kept but required lost`);
                continue;
            }
            assert.deepEqual(after.get(path), req, `${path}: required changed`);
        }
    }
    function propertyExists(params, path) {
        const segs = path.split('.').slice(1);
        let node = params;
        for (let seg of segs) {
            const arr = seg.endsWith('[]');
            if (arr) seg = seg.slice(0, -2);
            node = node && node.properties && node.properties[seg];
            if (!node) return false;
            if (arr) node = node.items;
        }
        return !!node;
    }
});

test('the lean core block is ≤ 32,000 chars and no single tool is over 3,000', () => {
    const all = JSON.stringify(lean());
    assert.ok(all.length <= 32_000, `lean core block: ${all.length} chars`);
    for (const t of lean()) {
        const n = JSON.stringify(t).length;
        assert.ok(n <= 3000, `${t.function.name}: ${n} chars`);
    }
    // And it is a real diet against the full core block.
    assert.ok(all.length < JSON.stringify(CORE).length / 2, 'less than half the full core block');
});

test('no scope or caseName anywhere (no flowlets, no switch on this menu)', () => {
    const walk = (node, seen) => {
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node.properties || {})) { seen.add(k); walk(v, seen); }
        if (node.items) walk(node.items, seen);
    };
    for (const t of lean()) {
        const seen = new Set();
        walk(t.function.parameters, seen);
        assert.ok(!seen.has('scope'), `${t.function.name} still has scope`);
        assert.ok(!seen.has('caseName'), `${t.function.name} still has caseName`);
    }
});

test('the keywords Gemma cannot render are gone from schema nodes, and property NAMES are never touched', () => {
    const walkNodes = (node, out) => {
        if (!node || typeof node !== 'object') return out;
        for (const k of UNRENDERED_KEYWORDS) if (k in node) out.push(k);
        for (const v of Object.values(node.properties || {})) walkNodes(v, out);
        if (node.items) walkNodes(node.items, out);
        return out;
    };
    for (const t of lean()) assert.deepEqual(walkNodes(t.function.parameters, []), [], `${t.function.name}: keyword left`);
    // A property CALLED maxItems / format is a name, not a keyword.
    const node = { type: 'object', maxItems: 3, properties: { maxItems: { type: 'number', default: 5 }, format: { type: 'string', enum: ['pdf'] } } };
    _stripUnrenderedKeywords(node);
    assert.deepEqual(Object.keys(node.properties), ['maxItems', 'format']);
    assert.ok(!('maxItems' in node) && !('default' in node.properties.maxItems));
});

test('additionalProperties:false stays on builder_add_steps.steps.items (measured: keeps fields inside spec)', () => {
    const items = leanTool('builder_add_steps').function.parameters.properties.steps.items;
    assert.equal(items.additionalProperties, false);
    assert.deepEqual(items.required, ['type', 'spec']);
});

test('the batch type enum names only types whose single tool is on the lean menu', () => {
    const en = leanTool('builder_add_steps').function.parameters.properties.steps.items.properties.type.enum;
    assert.deepEqual(en, [...LEAN_BATCH_TYPES]);
    const names = new Set(lean().map(t => t.function.name));
    const toolFor = { integration_action: 'builder_add_action', ai_step: 'builder_add_ai_step', data_extraction: 'builder_add_data_extraction', condition: 'builder_add_condition', notification: 'builder_add_notification', http_request: 'builder_add_http_request', datatable: 'builder_add_datatable', approval: 'builder_add_approval', array_op: 'builder_add_array_op' };
    for (const type of en) assert.ok(names.has(toolFor[type]), `${type} → ${toolFor[type]} is on the menu`);
    assert.ok(!en.includes('loop') && !en.includes('switch') && !en.includes('set') && !en.includes('form_page'));
});

test('every property the few-shot batches put inside spec exists on the matching projected single tool', () => {
    const shared = new Set(['afterStepId', 'branch', 'label', 'forEach', 'splice']);
    const toolFor = { integration_action: 'builder_add_action', ai_step: 'builder_add_ai_step', data_extraction: 'builder_add_data_extraction', condition: 'builder_add_condition', notification: 'builder_add_notification', http_request: 'builder_add_http_request', datatable: 'builder_add_datatable', approval: 'builder_add_approval', array_op: 'builder_add_array_op' };
    const batches = buildFewShotMessages(3, { toolset: 'core' })
        .flatMap(m => m.tool_calls || [])
        .filter(tc => tc.function.name === 'builder_add_steps')
        .map(tc => JSON.parse(tc.function.arguments));
    assert.ok(batches.length >= 3, 'three examples, three batches');
    for (const b of batches) {
        for (const entry of b.steps) {
            const props = leanTool(toolFor[entry.type]).function.parameters.properties;
            for (const k of Object.keys(entry.spec)) {
                assert.ok(shared.has(k) || k in props, `${entry.type}.spec.${k} is not a property of ${toolFor[entry.type]} on the lean menu`);
            }
        }
    }
});

test('builder_set_metadata says FIRST reply on both variants, with the same sentence', () => {
    const full = CORE.find(t => t.function.name === 'builder_set_metadata').function.description;
    assert.equal(full, SET_METADATA_DESCRIPTION);
    assert.equal(leanTool('builder_set_metadata').function.description, SET_METADATA_DESCRIPTION);
    assert.match(full, /FIRST reply/);
    assert.match(full, /≤ 60 chars/);
});

test('the projected trigger tool: kind enum restricted, the long-tail params gone, the form kept', () => {
    const p = leanTool('builder_propose_trigger').function.parameters.properties;
    assert.deepEqual(p.kind.enum, ['schedule', 'manual', 'webhook', 'form', 'app_event']);
    for (const gone of ['params', 'toolName', 'parametersSchema']) assert.ok(!(gone in p), `${gone} dropped`);
    const field = p.form.properties.fields.items.properties;
    for (const kept of ['name', 'type', 'label', 'required', 'placeholder', 'options', 'accept', 'maxSizeMb', 'source']) assert.ok(kept in field, `form field ${kept}`);
    for (const gone of ['multiple', 'maxItems', 'withText']) assert.ok(!(gone in field), `form field ${gone} dropped`);
    assert.match(field.source.description, /fireflies_transcript|meeting_note/, 'the real pick-source list survives');
    assert.match(leanTool('builder_propose_trigger').function.description, /## Triggers/);
});

test('shared params are stated once, in the lean wording, on every graph tool that has them', () => {
    for (const t of lean()) {
        const p = t.function.parameters.properties || {};
        if (p.branch) {
            assert.deepEqual(p.branch.enum, ['then', 'else', 'error']);
            assert.match(p.branch.description, /"error" = run only when afterStepId fails/);
        }
        if (p.forEach) assert.deepEqual(Object.keys(p.forEach.properties), ['overRef', 'itemVar', 'maxIterations']);
        if (p.splice) assert.match(p.splice.description, /insert BETWEEN/);
    }
    assert.ok(leanTool('builder_add_datatable').function.parameters.properties.forEach, 'the datatable write keeps forEach');
    assert.ok(!leanTool('builder_add_approval').function.parameters.properties.forEach, 'an approval never had forEach');
});

test('the per-tool diet removed what it says it removed', () => {
    const ai = leanTool('builder_add_ai_step').function.parameters.properties;
    for (const gone of ['tools', 'useMemory', 'agentPermissions']) assert.ok(!(gone in ai), `ai_step.${gone}`);
    const http = leanTool('builder_add_http_request').function.parameters.properties;
    for (const gone of ['askOnce', 'cacheInto']) assert.ok(!(gone in http), `http_request.${gone}`);
    const appr = leanTool('builder_add_approval').function.parameters.properties;
    for (const gone of ['approvers', 'rule', 'quorum', 'finalApprover', 'stages', 'remindAfterHours', 'escalateTo', 'escalateAfterHours']) assert.ok(!(gone in appr), `approval.${gone}`);
    assert.ok(!('cursor' in leanTool('builder_add_datatable').function.parameters.properties));
    assert.ok(!('tool' in leanTool('builder_inspect_tool').function.parameters.properties), 'the legacy single-tool form is gone');
    assert.ok(!('triggerStepId' in leanTool('builder_request_dry_run').function.parameters.properties));
    assert.match(leanTool('builder_update_step').function.description, /ONE builder_update_step per failing step/);
    assert.ok(!/builder_update_steps|builder_replace_step|builder_add_loop|builder_wire_error_branch/.test(JSON.stringify(lean())), 'no lean text names a dropped tool');
});

test('byte-stable: two projections of the same menu are the same bytes', () => {
    assert.equal(JSON.stringify(lean()), JSON.stringify(lean()));
});

// M5: the projection teaches what the builder writes — a pick for a value,
// `{{ }}` text in a text field — and its examples are picks, not refs.
test('the lean menu teaches the compact pick and shows no ref example', () => {
    const tools = lean();
    const text = JSON.stringify(tools);
    assert.match(leanTool('builder_add_action').function.description, /\{pick:"<path>"\}/);
    assert.match(leanTool('builder_add_action').function.description, /take:"all"/);
    assert.match(leanTool('builder_add_steps').function.parameters.properties.steps.items.properties.spec.description, /Values are picks/);
    assert.match(leanTool('builder_add_notification').function.description, /never JSON/);
    assert.ok(!/kind:\\?"ref\\?"/.test(text), 'no {kind:"ref"} example left on the lean menu');
    // The full schemas carry the same hint, and the ref stays accepted.
    const full = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_action').function.description;
    assert.match(full, /\{"pick":"steps\.<id>\.output\.<field>"\}/);
    assert.match(full, /still works/);
});
