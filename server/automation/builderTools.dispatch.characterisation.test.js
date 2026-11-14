// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the builder's tool dispatch: which apply
 * function a tool name reaches and what it is handed. Every tool in
 * TOOL_SCHEMAS (and a name that is none) is called through applyToolCall
 *
 *   - in the main flow with valid arguments,
 *   - inside a flowlet (scope) with the same arguments,
 *   - with a scope that names no flowlet,
 *   - with no arguments at all,
 *
 * and each case records the result plus what the call changed: the step ids
 * of the main flow and of every flowlet, the wrapper's own fields, and a hash
 * of the whole definition. The main flow and the flowlet hold steps with
 * the same ids, so a call that lands in the wrong graph, on the draft instead
 * of its wrapper or the other way round, shows up in what is left behind.
 *
 * Step ids are random; they are numbered in order of appearance per case.
 * The store and the runner are replaced at their exports for the two tools
 * that save (builder_finalize, builder_request_dry_run).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --require ./testUtils/registerFeatures.js --test automation/builderTools.dispatch.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const automationStore = require('../stores/automationStore');
const runner = require('../core/automationRunner');
const { applyToolCall, emptyDefinition, makeLayerSkeleton, TOOL_SCHEMAS } = require('./builderTools');

const GOLDEN = path.join(__dirname, 'builderTools.dispatch.characterisation.golden.json');
const lit = (value) => ({ kind: 'literal', value });
const ref = (p) => ({ kind: 'ref', path: p });

const FACTUREN = {
    id: 'tbl_1', key: 'facturen', name: 'Facturen', canWrite: true, managedKind: null,
    columns: [{ key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'totaal', name: 'Totaal', type: 'number' }],
};

/** The steps both the main flow and the flowlet `lk` hold, under the same ids. */
const sharedSteps = () => [
    { id: 'a', type: 'notification', title: 'Hi', body: 'B', channels: ['notification'], label: 'A' },
    { id: 'list', type: 'set', fields: { items: lit([{ n: 1 }, { n: 2 }]) }, label: 'List' },
    { id: 'call', type: 'call_layer', layerKey: 'other', inputs: { x: lit(1) }, label: 'Call' },
];
const chain = (first, ids) => ids.map((id, i) => ({ from: i ? ids[i - 1] : first, to: id }));

function baseDefinition() {
    const def = emptyDefinition();
    def.steps = sharedSteps();
    def.edges = chain('trg', ['a', 'list', 'call']);
    const lk = /** @type {any} */ (makeLayerSkeleton('Layer', [{ name: 'x', type: 'number' }]));
    lk.steps = [...sharedSteps(), ...lk.steps];
    lk.edges = chain('trg', ['a', 'list', 'call', 'out']);
    const other = /** @type {any} */ (makeLayerSkeleton('Other', [{ name: 'x', type: 'number' }]));
    other.steps = [{ id: 'oa', type: 'notification', title: 'In other', body: '', channels: ['notification'], label: 'OA' }, ...other.steps];
    other.edges = chain('trg', ['oa', 'out']);
    def.layers = { lk, other };
    return def;
}

/** @param {Record<string, unknown>} [extra] */
const wrapOf = (extra = {}) => ({
    userId: 'u_test', def: baseDefinition(), _inspectedTools: new Set(),
    _stageDatatables: true, _datatables: [structuredClone(FACTUREN)], ...extra,
});
// The two tools that save run without an owner, so the owner's catalogues
// (agents, assignees, knowledge bases) are not looked up.
const savedWrap = (extra = {}) => wrapOf({ userId: undefined, automationId: 'auto_1', ...extra });

/**
 * Valid arguments per tool. `wrap` builds the wrapper when the default does
 * not fit the tool.
 * @type {Record<string, { args: Record<string, unknown>, wrap?: () => Record<string, any> }>}
 */
const TOOLS = {
    builder_propose_trigger: { args: { kind: 'schedule', cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } },
    builder_add_trigger: { args: { kind: 'schedule', cron: '0 8 * * *', label: 'Daily' } },
    builder_update_trigger: { args: { triggerId: 'trg', patch: { label: 'Start' } } },
    builder_add_action: { args: { afterStepId: 'a', tool: 'gmail_search', inputs: { query: lit('is:unread') }, label: 'Search' } },
    builder_add_ai_step: { args: { afterStepId: 'a', prompt: 'Summarise {{steps.a.output.title}}', label: 'Think' } },
    builder_add_condition: { args: { afterStepId: 'a', expr: "steps.a.output.title == 'x'", label: 'Check' } },
    builder_add_loop: { args: { afterStepId: 'list', overRef: 'steps.list.output.items', itemVar: 'row', label: 'Each' } },
    builder_add_code_step: { args: { afterStepId: 'a', code: 'return { n: 1 };', label: 'Code' } },
    builder_add_notification: { args: { afterStepId: 'a', title: 'Done', body: 'ok', label: 'Tell' } },
    builder_add_http_request: { args: { afterStepId: 'a', url: 'https://example.test/hook', method: 'POST', label: 'Call out' } },
    builder_add_generate_document: { args: { afterStepId: 'a', content: '# Report', title: 'Report', label: 'Doc' } },
    builder_add_fill_document: { args: { afterStepId: 'a', documentId: 'doc_1', values: { name: lit('X') }, label: 'Fill' } },
    builder_add_slide: { args: { afterStepId: 'a', title: 'Slide one', content: 'Body', label: 'Slide' } },
    builder_add_presentation: { args: { afterStepId: 'a', slides: 'steps.a.output', title: 'Deck', label: 'Deck' } },
    builder_add_data_extraction: { args: { afterStepId: 'a', source: 'steps.a.output.body', fields: [{ name: 'total', type: 'number' }], label: 'Extract' } },
    builder_add_set: { args: { afterStepId: 'a', fields: { x: lit(1) }, label: 'Set' } },
    builder_add_call_layer: { args: { afterStepId: 'a', layerKey: 'other', inputs: { x: lit(2) }, label: 'Call other' } },
    builder_create_layer: { args: { title: 'New layer', params: [{ name: 'p', type: 'string' }] } },
    builder_set_layer_contract: { args: { layerKey: 'lk', params: [{ name: 'x', type: 'number' }, { name: 'z' }], outputs: { y: ref('steps.a.output.title') } } },
    builder_inline_layer: { args: { stepId: 'call' } },
    builder_add_datetime: { args: { afterStepId: 'a', op: 'now', label: 'Now' } },
    builder_add_wait: { args: { afterStepId: 'a', seconds: 30, label: 'Wait' } },
    builder_add_approval: { args: { afterStepId: 'a', prompt: 'OK?', label: 'Approve' } },
    builder_add_form_page: { args: { afterStepId: 'a', form: { title: 'More', fields: [{ name: 'street', type: 'text', label: 'Street' }] }, label: 'Page' } },
    builder_add_stop_error: { args: { afterStepId: 'a', message: 'Stop here', label: 'Stop' } },
    builder_add_switch: { args: { afterStepId: 'a', expr: 'steps.a.output.title', cases: [{ name: 'x', value: 'x' }, { name: 'y', value: 'y' }], label: 'Switch' } },
    builder_add_filter: { args: { afterStepId: 'list', arrayRef: 'steps.list.output.items', expr: 'item.n > 1', label: 'Filter' } },
    builder_add_limit: { args: { afterStepId: 'list', arrayRef: 'steps.list.output.items', count: 1, label: 'Limit' } },
    builder_add_dedupe: { args: { afterStepId: 'list', arrayRef: 'steps.list.output.items', keyField: 'n', label: 'Dedupe' } },
    builder_add_aggregate: { args: { afterStepId: 'list', arrayRef: 'steps.list.output.items', field: 'n', label: 'Agg' } },
    builder_add_summarize: { args: { afterStepId: 'list', arrayRef: 'steps.list.output.items', field: 'n', op: 'sum', label: 'Sum' } },
    builder_add_array_op: { args: { afterStepId: 'list', op: 'limit', arrayRef: 'steps.list.output.items', count: 1, label: 'Op' } },
    builder_add_datatable: { args: { afterStepId: 'a', op: 'insert', datatableId: 'tbl_1', values: { leverancier: lit('X') }, label: 'Row' } },
    builder_create_datatable: { args: { name: 'Invoices', fields: [{ name: 'Supplier', type: 'text' }, { name: 'Total', type: 'number' }] } },
    builder_add_knowledge_write: { args: { afterStepId: 'a', knowledgeBaseId: 'kb_1', content: 'Text', title: 'T', label: 'KB' } },
    builder_add_note: { args: { text: 'why', label: 'Note' } },
    builder_add_steps: { args: { steps: [
        { tempId: 't1', type: 'notification', spec: { title: 'One', afterStepId: 'a' } },
        { tempId: 't2', type: 'call_layer', spec: { layerKey: 'other', inputs: { x: ref('steps.$t1.output.title') }, afterStepId: '$t1' } },
    ] } },
    builder_wire_error_branch: { args: { fromStepId: 'a', toStepId: 'list' } },
    builder_remove_step: { args: { stepId: 'a', reconnect: true } },
    builder_update_step: { args: { stepId: 'a', patch: { title: 'New title' } } },
    builder_update_steps: { args: { updates: [{ stepId: 'a', patch: { body: 'New body' } }] } },
    builder_replace_step: { args: { stepId: 'a', newType: 'call_layer', spec: { layerKey: 'other', inputs: { x: lit(3) } } } },
    builder_set_metadata: { args: { title: 'My flow', description: 'What it does' } },
    builder_summarise: { args: {} },
    builder_inspect_tool: { args: { tool: 'gmail_search' } },
    builder_request_dry_run: { args: { triggerPayload: { subject: 'Hello' } }, wrap: savedWrap },
    builder_finalize: { args: {}, wrap: savedWrap },
    // Handled by the chat route, not by this dispatch.
    builder_generate_layer: { args: { title: 'x', instruction: 'y' } },
    builder_generate_layers: { args: { layers: [] } },
    builder_set_plan: { args: { todos: [] } },
    builder_no_such_tool: { args: { anything: 1 } },
};

/** Calls in a row on one wrapper: what a later call sees of an earlier one. */
const SEQUENCES = {
    // A refused batch entry, resent unchanged (dispatched patched), and sent a
    // third time: the batch is told what the model sent, not the patched form.
    'add_steps: refused, identical resend repaired, third send reused': [1, 2, 3].map(() => ['builder_add_steps', { steps: [
        { tempId: 'rd', type: 'integration_action', spec: { tool: 'gmail_read', forEach: { overRef: 'steps.list.output.items', itemVar: 'm' }, inputs: { messageId: ref('loop.x.id') } } },
    ] }]),
    'add_steps in a flowlet, then replace and inline there': [
        ['builder_add_steps', { scope: 'lk', steps: [{ tempId: 'n', type: 'notification', spec: { title: 'In scope', afterStepId: 'a' } }] }],
        ['builder_replace_step', { scope: 'lk', stepId: 'list', newType: 'call_layer', spec: { layerKey: 'other', inputs: { x: lit(4) } } }],
        ['builder_inline_layer', { scope: 'lk', stepId: 'call' }],
        ['builder_add_call_layer', { scope: 'other', layerKey: 'lk', afterStepId: 'oa' }],
    ],
    'dry run: unknown trigger, a staged preview, then a real one': [
        ['builder_request_dry_run', { triggerStepId: 'nope' }],
        ['builder_request_dry_run', {}, { _stagedDryRun: true }],
        ['builder_request_dry_run', {}, { _stagedDryRun: false }],
    ],
    'set_metadata twice, then finalize': [
        ['builder_set_metadata', { title: 'First' }],
        ['builder_set_metadata', { description: 'Second' }],
        ['builder_finalize', {}],
    ],
};
const SEQUENCE_WRAP = { 'dry run: unknown trigger, a staged preview, then a real one': savedWrap, 'set_metadata twice, then finalize': savedWrap };

// ── recording ───────────────────────────────────────────────────────────

/** JSON with Sets as sorted lists and functions named, so a wrapper is comparable. */
const plain = (value) => JSON.parse(JSON.stringify(value, (_k, v) => {
    if (v instanceof Set) return { $set: [...v].sort() };
    if (typeof v === 'function') return '$function';
    return v === undefined ? '$undefined' : v;
}) ?? 'null');

/** Number the random step ids of one case in order of appearance. */
function numbered(value) {
    const seen = new Map();
    const text = JSON.stringify(value).replace(/\b([a-z]+)_([0-9a-f]{6})\b/g, (whole, prefix) => {
        if (!seen.has(whole)) seen.set(whole, `${prefix}_#${seen.size + 1}`);
        return seen.get(whole);
    });
    return JSON.parse(text);
}

const idsOf = (graph) => (graph?.steps || []).map((s) => s && s.id);
/** What a call left behind. The hash is taken after the ids are numbered. */
function leftBehind(wrap) {
    const { def, ...rest } = wrap;
    const seen = numbered({
        main: idsOf(def),
        mainEdges: (def.edges || []).length,
        trigger: def.trigger?.kind,
        triggers: (def.triggers || []).map((t) => t && t.id),
        layers: Object.fromEntries(Object.entries(def.layers || {}).map(([k, g]) => [k, idsOf(g)])),
        wrapper: plain(rest),
        def: plain(def),
    });
    const { def: wholeDef, ...summary } = seen;
    return { ...summary, defHash: crypto.createHash('sha256').update(JSON.stringify(wholeDef)).digest('hex').slice(0, 16) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Only what differs from the untouched wrapper, so a case shows what its call did. */
function changedSince(base, left) {
    const wrapper = Object.fromEntries(Object.entries(left.wrapper).filter(([k, v]) => !same(v, base.wrapper[k])));
    const rest = Object.fromEntries(Object.entries(left).filter(([k, v]) => k !== 'wrapper' && !same(v, base[k])));
    const changed = { ...rest, ...(Object.keys(wrapper).length ? { wrapper } : {}) };
    return Object.keys(changed).length ? changed : 'nothing changed';
}

async function call(name, args, wrap) {
    try {
        return plain(await applyToolCall(name, args, wrap));
    } catch (err) {
        return { $threw: /** @type {Error} */ (err).message };
    }
}

async function record() {
    /** @type {Record<string, unknown>} */
    const out = {};
    const untouched = leftBehind(wrapOf());
    const untouchedSaved = leftBehind(savedWrap());
    for (const [name, { args, wrap = wrapOf }] of Object.entries(TOOLS)) {
        const variants = {
            main: args,
            flowlet: { ...args, scope: 'lk' },
            'unknown scope': { ...args, scope: 'nope' },
            'no arguments': {},
        };
        for (const [variant, sent] of Object.entries(variants)) {
            const w = wrap();
            const base = wrap === savedWrap ? untouchedSaved : untouched;
            const result = await call(name, structuredClone(sent), w);
            out[`${name} | ${variant}`] = numbered({ result, left: changedSince(base, leftBehind(w)) });
        }
    }
    for (const [title, calls] of Object.entries(SEQUENCES)) {
        const w = (SEQUENCE_WRAP[title] || wrapOf)();
        const results = [];
        for (const [name, args, flags] of calls) {
            Object.assign(w, flags || {});
            results.push(await call(name, structuredClone(args), w));
        }
        out[`sequence | ${title}`] = numbered({ results, left: changedSince(SEQUENCE_WRAP[title] ? untouchedSaved : untouched, leftBehind(w)) });
    }
    return out;
}

// ── the store and the runner, at their exports ──────────────────────────

const saved = {
    updateAutomation: automationStore.updateAutomation, getAutomation: automationStore.getAutomation,
    getRunSteps: automationStore.getRunSteps, executeAutomation: runner.executeAutomation,
};
/** @type {unknown[]} */
let storeCalls = [];
function installStubs() {
    const s = /** @type {Record<string, any>} */ (automationStore);
    s.updateAutomation = async (id, updates, userId) => {
        storeCalls.push(['updateAutomation', id, Object.keys(updates).sort(), updates.isDraft, userId ?? null]);
        return { id, title: updates.title || 'Stored title', isActive: false };
    };
    s.getAutomation = async (id) => { storeCalls.push(['getAutomation', id]); return null; };
    s.getRunSteps = async (runId) => {
        storeCalls.push(['getRunSteps', runId]);
        return [{ stepId: 'a', status: 'ok', output: { title: 'Hi', items: [{ n: 1 }] } }, { stepId: 'list', status: 'ok', output: null }];
    };
    /** @type {Record<string, any>} */ (runner).executeAutomation = async (automation, opts) => {
        storeCalls.push(['executeAutomation', automation && automation.id, { ...opts, onRunCreated: typeof opts.onRunCreated }]);
        return { id: 'run_1', status: 'ok', triggerPayload: opts.triggerPayload };
    };
}
function restoreStubs() { Object.assign(automationStore, saved, {}); /** @type {Record<string, any>} */ (runner).executeAutomation = saved.executeAutomation; }

test('every tool in TOOL_SCHEMAS has a row of arguments here', () => {
    const known = new Set(Object.keys(TOOLS));
    // The two document tools answer before the dispatch (core/documents/documentDiscovery).
    const missing = TOOL_SCHEMAS.map((t) => t.function.name)
        .filter((n) => !known.has(n) && !['builder_search_documents', 'builder_read_document'].includes(n));
    assert.deepEqual(missing, []);
});

test('the tool dispatch matches the golden file', async (t) => {
    installStubs();
    t.after(restoreStubs);
    storeCalls = [];
    const actual = plain({ cases: await record(), storeCalls });
    if (process.env.UPDATE_GOLDEN) {
        fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
        return;
    }
    const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual.cases), Object.keys(expected.cases));
    for (const name of Object.keys(expected.cases)) {
        assert.deepEqual(actual.cases[name], expected.cases[name], name);
    }
    assert.deepEqual(actual.storeCalls, expected.storeCalls);
});
