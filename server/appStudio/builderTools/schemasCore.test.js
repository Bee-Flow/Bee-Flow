'use strict';

/**
 * The core (small-band) tool projection — schemasCore.js.
 *
 * What these pin: the projection is a strict SUBSET of the full schema (a
 * field can be removed for the small band, never invented for it), it is
 * template-safe for Gemma's chat template (no `type: [..]` unions, no untyped
 * property — both render as garbage there), byte-stable and pure, and the
 * few-shots the core menu ships teach only fields the projected schema still
 * declares. The last test replays every recorded trace call and checks that
 * each `_suggestedPatch` op the tools emit names a path the declared schema
 * can hold — a patch the model applies to a field the schema does not know
 * is a patch it will never write correctly.
 *
 * Run: cd server && node --test --test-force-exit appStudio/builderTools/schemasCore.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TOOL_SCHEMAS } = require('./schemas');
const { projectCoreToolSchemas, CORE_PRUNE, nodeAt } = require('./schemasCore');
const { APP_CORE_TOOL_NAMES, selectToolMenu, getProfileForModel } = require('../builderModelProfiles');
const { ACTION_KINDS, STEP_KINDS, emptyDefinition } = require('../componentSpecs');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const coreList = () => TOOL_SCHEMAS.filter((t) => APP_CORE_TOOL_NAMES.has(t.function.name));
const byName = (list, name) => list.find((t) => t.function.name === name);

/** Every property path in a schema tree: `components.items.props`, … */
function propertyPaths(node, prefix, out) {
    if (!isObject(node)) return out;
    if (isObject(node.properties)) {
        for (const [k, v] of Object.entries(node.properties)) {
            const p = prefix ? `${prefix}.${k}` : k;
            out.push({ path: p, node: v });
            propertyPaths(v, p, out);
        }
    }
    if (isObject(node.items)) propertyPaths(node.items, prefix ? `${prefix}.items` : 'items', out);
    return out;
}

test('the projection is a strict subset: every core property path exists in the full schema', () => {
    const core = projectCoreToolSchemas(coreList());
    assert.equal(core.length, coreList().length, 'same tools, same order');
    for (const tool of core) {
        const full = byName(TOOL_SCHEMAS, tool.function.name);
        assert.ok(full, `${tool.function.name} exists in the full schema`);
        for (const { path: p, node } of propertyPaths(tool.function.parameters, '', [])) {
            const inFull = nodeAt(full.function.parameters, p);
            assert.ok(inFull, `${tool.function.name}: ${p} is not in the full schema`);
            assert.equal(node.type, inFull.type, `${tool.function.name}: ${p} keeps the full schema's type`);
            if (node.enum) assert.deepEqual(node.enum, inFull.enum, `${tool.function.name}: ${p} keeps the full enum`);
        }
        // required ⊆ properties, always.
        const req = tool.function.parameters.required || [];
        for (const r of req) assert.ok(r in tool.function.parameters.properties, `${tool.function.name}: required ${r} is declared`);
    }
});

test('every prune rule names fields the full schema has (a rename in schemas.js fails here, not at boot)', () => {
    for (const [name, rule] of Object.entries(CORE_PRUNE)) {
        const full = byName(TOOL_SCHEMAS, name);
        assert.ok(full, `${name} exists`);
        assert.ok(APP_CORE_TOOL_NAMES.has(name), `${name} is on the core menu (a rule for an off-menu tool is dead)`);
        for (const k of [...(rule.keep || []), ...(rule.drop || [])]) assert.ok(k in full.function.parameters.properties, `${name}.${k}`);
        for (const [p, sub] of Object.entries(rule.at || {})) {
            const node = nodeAt(full.function.parameters, p);
            assert.ok(node, `${name}.${p}`);
            for (const k of [...(sub.keep || []), ...(sub.drop || [])]) assert.ok(k in node.properties, `${name}.${p}.${k}`);
        }
    }
});

test('template-safe: no property has an array type, every property has a type', () => {
    const core = projectCoreToolSchemas(coreList());
    for (const tool of core) {
        for (const { path: p, node } of propertyPaths(tool.function.parameters, '', [])) {
            assert.ok(typeof node.type === 'string', `${tool.function.name}: ${p} has no type (renders as properties:{} on Gemma)`);
            assert.ok(!Array.isArray(node.type), `${tool.function.name}: ${p} has a union type (renders as a literal list on Gemma)`);
            if (node.type === 'array') assert.ok(isObject(node.items) && typeof node.items.type === 'string', `${tool.function.name}: ${p} array declares typed items`);
        }
    }
    // The two the diet fixed by name.
    const bind = byName(core, 'app_bind_action').function.parameters.properties;
    assert.deepEqual(bind.actionId, { type: 'string', nullable: true, description: 'Action id (act_…); null to unwire.' });
    assert.equal(bind.bindings.items.properties.actionId.nullable, true);
    const table = byName(core, 'app_upsert_table').function.parameters.properties.fields.items.properties;
    assert.equal(table.default.type, 'string');
    assert.equal(table.readOnly, undefined);
    const add = byName(core, 'app_add_components').function.parameters.properties.components.items.properties;
    assert.equal(add.readOnly, undefined, 'readOnly is pruned from the core add form');
    assert.equal(byName(TOOL_SCHEMAS, 'app_add_components').function.parameters.properties.components.items.properties.readOnly.type, 'string', 'and typed on the full one');
});

test('app_set_action.action carries a real properties block whose enums are the spec vocabulary', () => {
    const core = projectCoreToolSchemas(coreList());
    const action = byName(core, 'app_set_action').function.parameters.properties.action;
    assert.ok(isObject(action.properties), 'the action object is no longer an empty box');
    assert.deepEqual(action.properties.kind.enum, [...ACTION_KINDS]);
    assert.deepEqual(action.required, ['kind']);
    assert.deepEqual(action.properties.steps.items.properties.kind.enum, [...STEP_KINDS]);
    for (const k of ['tableId', 'values', 'message', 'tone', 'screenId', 'modalId', 'resultVar', 'automationId', 'inputMapping', 'form', 'recordId']) {
        assert.ok(k in action.properties.steps.items.properties, `step field ${k} declared`);
    }
    // The batch item points at the single form instead of repeating ~3k of schema.
    const item = byName(core, 'app_set_action').function.parameters.properties.actions.items.properties.action;
    assert.equal(item.properties, undefined);
    assert.match(item.description, /Same shape as `action`/);
    // Same on the full schema — the fix is generic.
    assert.deepEqual(byName(TOOL_SCHEMAS, 'app_set_action').function.parameters.properties.action.properties.kind.enum, [...ACTION_KINDS]);
});

test('app_update_component is batch-only on the core menu, and the tool still reads a stray single form', async () => {
    const core = projectCoreToolSchemas(coreList());
    const params = byName(core, 'app_update_component').function.parameters;
    assert.deepEqual(Object.keys(params.properties), ['updates']);
    assert.deepEqual(params.required, ['updates']);
    assert.deepEqual(Object.keys(params.properties.updates.items.properties), ['id', 'props', 'style', 'visible', 'visibleWhen', 'computed']);
    assert.deepEqual(params.properties.updates.items.required, ['id']);
    // The full schema keeps its single form.
    assert.ok('id' in byName(TOOL_SCHEMAS, 'app_update_component').function.parameters.properties);

    // Run-time tolerance: a single-form call from a model that read the
    // schema loosely still lands (readBatchArg's single path is untouched).
    const { applyToolCall } = require('../builderTools');
    const wrap = { userId: 'u1', def: emptyDefinition('x'), dataModel: null, datasetIds: [], rowCounts: {} };
    const added = await applyToolCall('app_add_components', { parentId: wrap.def.screens[0].sections[0].id, components: [{ tempId: 'h', type: 'heading', props: { text: 'Hi' } }] }, wrap);
    const single = await applyToolCall('app_update_component', { id: added.ids.h, props: { text: 'Hello' } }, wrap);
    assert.equal(single.updated, added.ids.h, JSON.stringify(single));
    const batch = await applyToolCall('app_update_component', { updates: [{ id: added.ids.h, props: { text: 'Hey' } }] }, wrap);
    assert.equal(batch.applied, 1, JSON.stringify(batch));
});

test('pure, cached and byte-stable: the full schemas are untouched and two calls share one object graph', () => {
    const before = JSON.stringify(TOOL_SCHEMAS);
    const list = coreList();
    const a = projectCoreToolSchemas(list);
    const b = projectCoreToolSchemas(list);
    assert.equal(a, b, 'same input array → same (cached) projection');
    assert.equal(JSON.stringify(a), JSON.stringify(projectCoreToolSchemas(coreList())), 'a fresh filter → byte-identical text');
    assert.equal(JSON.stringify(TOOL_SCHEMAS), before, 'TOOL_SCHEMAS is never mutated');
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a[0].function.parameters), 'frozen — nothing downstream can drift it');
    assert.ok(JSON.stringify(a).length < JSON.stringify(list).length * 0.85, `the core menu is materially smaller (${JSON.stringify(a).length} vs ${JSON.stringify(list).length})`);
    // The route's selector hands the core band this projection and every other band the full list.
    const small = selectToolMenu(getProfileForModel('gemma-4-26b-a4b'), TOOL_SCHEMAS);
    assert.deepEqual(small.map((t) => t.function.name).sort(), [...APP_CORE_TOOL_NAMES].sort());
    assert.equal(JSON.stringify(small), JSON.stringify(a));
    assert.equal(small, selectToolMenu(getProfileForModel('gemma-4-26b-a4b'), TOOL_SCHEMAS), 'the selector caches too');
    assert.equal(selectToolMenu(getProfileForModel('claude-sonnet-5'), TOOL_SCHEMAS), TOOL_SCHEMAS, 'full band: the list itself');
});

/**
 * Does every key of `args` exist in the schema? Free-form objects (a schema
 * node with no `properties`, e.g. props / style / values) accept anything.
 * Returns the offending paths.
 */
function keysOutsideSchema(args, node, at, out) {
    if (!isObject(node)) return out;
    if (Array.isArray(args)) {
        if (isObject(node.items)) args.forEach((v, i) => keysOutsideSchema(v, node.items, `${at}[${i}]`, out));
        return out;
    }
    if (!isObject(args) || !isObject(node.properties)) return out;
    for (const [k, v] of Object.entries(args)) {
        if (!(k in node.properties)) { out.push(`${at}.${k}`); continue; }
        keysOutsideSchema(v, node.properties[k], `${at}.${k}`, out);
    }
    return out;
}

test('every core few-shot call uses only fields the projected core schema declares', () => {
    const { buildFewShotMessages } = require('../builderPrompt/fewShots');
    const core = projectCoreToolSchemas(coreList());
    for (const msg of buildFewShotMessages(3, { toolset: 'core' })) {
        for (const call of msg.tool_calls || []) {
            const tool = byName(core, call.function.name);
            assert.ok(tool, `few-shot calls ${call.function.name}, which is not on the core menu`);
            const args = JSON.parse(call.function.arguments);
            const outside = keysOutsideSchema(args, tool.function.parameters, call.function.name, []);
            assert.deepEqual(outside, [], `the shot teaches a field the core schema does not declare`);
        }
    }
});

/** Does a `_suggestedPatch` op path resolve inside a schema? Free-form objects accept any tail. */
function pathResolves(schema, opPath) {
    const tokens = String(opPath).match(/[^.[\]]+|\[\d+\]/g) || [];
    let cur = schema;
    for (const tok of tokens) {
        if (!isObject(cur)) return false;
        if (/^\d+$/.test(tok)) { // an index: the array's items
            if (cur.type !== 'array') return false;
            cur = cur.items || {};
            continue;
        }
        if (!isObject(cur.properties)) return true; // free-form object: anything below is legal
        if (!(tok in cur.properties)) return false;
        cur = cur.properties[tok];
    }
    return true;
}

test('every _suggestedPatch op path the tools emit for the recorded traces resolves inside the declared schema', async () => {
    const { applyToolCall } = require('../builderTools');
    const { mergeTableOp } = require('./dataTools');
    const { canonicalizeDataModel, emptyDataModel } = require('../dataModel');
    const core = projectCoreToolSchemas(coreList());
    const dir = path.join(__dirname, 'traces');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 3, 'the recorded corpus is present');

    // A model with the tables the traces name by handle, so the guard's
    // did-you-mean patches (the ones with paths) actually fire.
    let model = emptyDataModel();
    for (const args of [
        { name: 'Suppliers', fields: [{ key: 'name', type: 'text' }, { key: 'email', type: 'text' }, { key: 'category', type: 'select', options: ['utilities', 'hardware'] }] },
        { name: 'Invoices', fields: [{ key: 'supplier_id', type: 'text' }, { key: 'invoice_no', type: 'text' }, { key: 'amount', type: 'number' }, { key: 'due_date', type: 'date' }] },
        { name: 'Facturen', fields: [{ key: 'factuur_datum', type: 'date' }, { key: 'leverancier', type: 'text' }, { key: 'totaal_bedrag', type: 'number' }, { key: 'btw_bedrag', type: 'number' }, { key: 'status', type: 'text' }] },
    ]) {
        const merged = mergeTableOp(model, args, {});
        assert.ok(!merged.error, JSON.stringify(merged));
        model = canonicalizeDataModel(merged.model).model;
    }
    // ...with PINNED ids. mergeTableOp mints `tbl_` + three random bytes, and
    // the validator's did-you-mean (pickClosestId, Levenshtein <= 5 over the
    // whole id) only turns a stale id into a patch when a minted id happens to
    // lie that close to one the trace wrote. About one draw in a hundred came
    // near none of the app_set_action calls, and the last assertion below
    // failed on the dice (a dependabot run, 2026-09-23). Each pin is one
    // character off a table id a trace wrote — the garbled-id shape the
    // did-you-mean exists for — so every run checks every patch shape:
    // Suppliers next to tbl_52aad5 (the playbook run's second table: the
    // batch app_set_action and components[i].props.source), Invoices next to
    // tbl_ab859b (the invoice-dashboard trace), Facturen next to tbl_4f645b.
    const PINNED = { suppliers: 'tbl_52aad4', invoices: 'tbl_ab859c', facturen: 'tbl_4f645e' };
    model = canonicalizeDataModel({ ...model, tables: model.tables.map((t) => ({ ...t, id: PINNED[t.key] })) }).model;
    assert.deepEqual(Object.fromEntries(model.tables.map((t) => [t.key, t.id])), PINNED, 'the pinned ids survive canonicalization');

    let patches = 0;
    const seen = new Set();
    for (const f of files) {
        const trace = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const wrap = { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_sc', def: emptyDefinition(trace.name || 'Trace'), dataModel: model, dataModelVersion: 1, rowCounts: {}, datasetIds: [], _ownerDatatables: [] };
        for (const c of trace.calls) {
            if (!c || typeof c.tool !== 'string' || c.tool === 'app_finalize') continue;
            let r;
            try { r = await applyToolCall(c.tool, c.args, wrap); } catch (e) { r = { error: e.message }; }
            const ops = [
                ...(r && r._suggestedPatch && Array.isArray(r._suggestedPatch.ops) ? r._suggestedPatch.ops : []),
                ...(r && Array.isArray(r.failed) ? r.failed.flatMap((x) => (x && x._suggestedPatch && Array.isArray(x._suggestedPatch.ops) ? x._suggestedPatch.ops : [])) : []),
            ];
            for (const op of ops) {
                const tool = byName(TOOL_SCHEMAS, c.tool);
                const coreTool = byName(core, c.tool);
                for (const p of [op.path, op.from, op.to].filter((x) => typeof x === 'string')) {
                    patches += 1;
                    seen.add(`${c.tool}: ${p.replace(/\[\d+\]/g, '[i]')}`);
                    assert.ok(pathResolves(tool.function.parameters, p), `${f} call ${c.n} ${c.tool}: patch path ${p} does not resolve in the full schema`);
                    if (coreTool) assert.ok(pathResolves(coreTool.function.parameters, p), `${f} call ${c.n} ${c.tool}: patch path ${p} does not resolve in the CORE schema`);
                }
            }
        }
    }
    assert.ok(patches > 0, 'sanity: the replay produced at least one _suggestedPatch to check');
    // Two of the shapes the corpus is known to produce.
    assert.ok([...seen].some((s) => /^app_set_action: /.test(s)), `an action patch was checked: ${[...seen].join(' | ')}`);
});
