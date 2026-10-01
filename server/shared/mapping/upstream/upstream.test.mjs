/**
 * Upstream discovery in the core: the regressions for every confirmed bug of
 * the old agent-hub describers, and the property that every offered path
 * resolves at run time to what the picker showed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkPath } from '../legacy.mjs';
import { formatPath, isWild } from '../source.mjs';
import {
    computeUpstreamGroups, computeLoopBodyGroups, describeNode, overlayGroupWithReal, seg, sampleToFields,
    collectArrayPaths, inferLoopItemSample, buildToolOutputMap, DESCRIBED_TYPES, runsPerItem,
} from './index.mjs';

function allNodes(fields) {
    const out = [];
    const visit = (f) => { out.push(f); (f.children || []).forEach(visit); };
    (fields || []).forEach(visit);
    return out;
}
const paths = (g) => allNodes(g?.fields).map(f => f.path);
const group = (groups, id) => groups.find(g => g.id === id);

/** The run-time root the groups' samples describe. */
function rootOf(groups) {
    const root = { trigger: { output: {} }, steps: {}, loop: {} };
    for (const g of groups) {
        if (g.basePath === 'trigger.output') root.trigger.output = g.sample;
        else if (g.basePath.startsWith('loop.')) root.loop[g.basePath.slice(5)] = g.sample;
        else if (g.basePath.startsWith('steps.')) root.steps[g.id] = { output: g.sample };
    }
    return root;
}

const ROWS = [{ 'Order ID': 1, 'line-items': [{ 'unit price': 10 }], customer: { 'E-mail adres': 'a@b.nl' } }, { 'Order ID': 2, 'line-items': [] }];

function chain() {
    return {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'src', type: 'set', fields: { rows: { kind: 'literal', value: ROWS } } },
            { id: 'flt', type: 'filter', arrayRef: 'steps.src.output.rows' },
            { id: 'lst', type: 'set', arrayRef: 'steps.src.output.rows', fields: { 'Total due': { kind: 'literal', value: 5 } } },
            { id: 'lp', type: 'loop', overRef: 'steps.src.output.rows', itemVar: 'row', body: [{ id: 'b1', type: 'set', fields: { summary: { kind: 'ref', path: 'loop.row["Order ID"]' } } }] },
            { id: 'last', type: 'code' },
        ],
        edges: [{ from: 't', to: 'src' }, { from: 'src', to: 'flt' }, { from: 'flt', to: 'lst' }, { from: 'lst', to: 'lp' }, { from: 'lp', to: 'last' }],
    };
}

test('property: every offered path resolves through the runtime walker to the value its Source names', () => {
    const groups = computeUpstreamGroups(chain(), 'last', null);
    const root = rootOf(groups);
    let checked = 0;
    for (const g of groups) {
        for (const n of allNodes(g.fields)) {
            if (!n.source) continue;
            assert.equal(formatPath(n.source), n.path, `one quoting rule: ${n.path}`);
            assert.notEqual(walkPath(n.path, root), undefined, `resolves at run time: ${n.path}`);
            checked++;
        }
    }
    assert.ok(checked > 20);
});

test('collection item columns, Set list rows and loop results escape their keys', () => {
    const groups = computeUpstreamGroups(chain(), 'last', null);
    assert.ok(paths(group(groups, 'flt')).includes('steps.flt.output.items[*]["Order ID"]'));
    assert.ok(paths(group(groups, 'flt')).includes('steps.flt.output.items[*]["line-items"][*]["unit price"]'));
    assert.ok(paths(group(groups, 'lst')).includes('steps.lst.output.items[*]["Total due"]'));
    assert.ok(paths(group(groups, 'lp')).includes('steps.lp.output.results[*].item["Order ID"]'));
    for (const p of groups.flatMap(paths)) {
        assert.doesNotMatch(p, /\.[^.[\]"']*[ -]/, `no raw key with a space or hyphen: ${p}`);
    }
});

test('trigger params and form fields are escaped', () => {
    const def = { trigger: { id: 't', kind: 'layer_input', params: [{ name: 'first name', type: 'string' }, { name: 'e-mail' }, { name: 'ok' }] }, steps: [{ id: 's', type: 'code' }], edges: [{ from: 't', to: 's' }] };
    const [g] = computeUpstreamGroups(def, 's', null);
    assert.deepStrictEqual(paths(g), ['trigger.output["first name"]', 'trigger.output["e-mail"]', 'trigger.output.ok']);
    const form = { trigger: { id: 't', kind: 'form', form: { fields: [{ name: 'Your name', type: 'text' }] } }, steps: [{ id: 's', type: 'code' }], edges: [] };
    assert.deepStrictEqual(paths(computeUpstreamGroups(form, 's', null)[0]), ['trigger.output["Your name"]']);
});

test('one quoting rule: seg delegates to formatSegment', () => {
    assert.equal(seg('ok'), '.ok');
    assert.equal(seg('line-items'), '["line-items"]');
    assert.equal(seg('a"b'), `['a"b']`);
    assert.equal(seg('a\\b'), '["a\\b"]');
    assert.equal(seg('a]b'), null);
    const fields = sampleToFields({ 'a"b': 1, 'a\\b': 2 }, 'trigger.output');
    const root = { trigger: { output: { 'a"b': 1, 'a\\b': 2 } } };
    assert.deepStrictEqual(fields.map(f => walkPath(f.path, root)), [1, 2]);
});

test('forEach reshape escapes keys and keeps nested children', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'cal', type: 'integration_action', tool: 'cal', forEach: { overRef: 'trigger.output.items' } },
            { id: 'next', type: 'code' },
        ],
        edges: [{ from: 't', to: 'cal' }, { from: 'cal', to: 'next' }],
    };
    const catalog = { apps: [{ actions: [{ name: 'cal', outputSample: { organizer: { email: 'x@y' }, 'Order ID': 1, list: [1] } }] }] };
    const g = group(computeUpstreamGroups(def, 'next', catalog), 'cal');
    assert.deepStrictEqual(paths(g), [
        'steps.cal.output.iterations', 'steps.cal.output.succeeded', 'steps.cal.output.failed',
        'steps.cal.output.results[*].output.organizer',
        'steps.cal.output.results[*].output.organizer.email',
        'steps.cal.output.results[*].output["Order ID"]',
        'steps.cal.output.results[*].output.list',
    ]);
    const orderId = allNodes(g.fields).find(f => f.key === 'Order ID');
    assert.deepStrictEqual(orderId.sample, [1]);
    assert.equal(orderId.perIteration, true);
    assert.equal(allNodes(g.fields).find(f => f.key === 'list').perIteration, undefined);
    const run = { steps: { cal: { output: { results: [{ output: { organizer: { email: 'a' } } }, { output: { organizer: { email: 'b' } } }] } } } };
    assert.deepStrictEqual(walkPath('steps.cal.output.results[*].output.organizer.email', run), ['a', 'b']);
});

test('regression (M6): a repeating step shows downstream as its results entries, like forEach', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'cal', type: 'integration_action', tool: 'cal', repeat: { over: { root: 'trigger', path: ['items'] }, max: 100 } },
            { id: 'next', type: 'code' },
        ],
        edges: [{ from: 't', to: 'cal' }, { from: 'cal', to: 'next' }],
    };
    const catalog = { apps: [{ actions: [{ name: 'cal', outputSample: { organizer: { email: 'x@y' }, events: [{ id: 'e1' }] } }] }] };
    const g = group(computeUpstreamGroups(def, 'next', catalog), 'cal');
    assert.equal(g.forEach, true);
    assert.deepStrictEqual(paths(g), [
        'steps.cal.output.iterations', 'steps.cal.output.succeeded', 'steps.cal.output.failed',
        'steps.cal.output.results[*].output.organizer',
        'steps.cal.output.results[*].output.organizer.email',
        'steps.cal.output.results[*].output.events',
        'steps.cal.output.results[*].output.events[*].id',
    ]);
    // The element of a list read through the repeating step's entries resolves
    // against the fan-out envelope, not the flat output.
    const toolToOutput = buildToolOutputMap(catalog);
    assert.deepStrictEqual(inferLoopItemSample('steps.cal.output.results[*].output.events', def, toolToOutput), { id: 'e1' });
});

test('runsPerItem: forEach with an overRef or repeat with an over', () => {
    assert.equal(runsPerItem({ forEach: { overRef: 'x' } }), true);
    assert.equal(runsPerItem({ repeat: { over: { root: 'trigger', path: [] } } }), true);
    assert.equal(runsPerItem({ forEach: {} }), false);
    assert.equal(runsPerItem({ repeat: {} }), false);
    assert.equal(runsPerItem({}), false);
    assert.equal(runsPerItem(null), false);
});

test('an AI step without its own schema offers its leading skill\'s fields', () => {
    const node = { id: 'ai', type: 'ai_step', skillIds: ['sk1'] };
    const catalog = { skillOutputs: { sk1: { outputFields: [{ key: 'summary', type: 'string' }, { key: 'score', type: 'number' }] } } };
    assert.deepStrictEqual(paths(describeNode(node, {}, new Map(), {}, null, catalog)), ['steps.ai.output.summary', 'steps.ai.output.score']);
    const schemaSkill = { skillOutputs: { sk1: { outputSchema: { type: 'object', properties: { topic: { type: 'string' } } } } } };
    assert.deepStrictEqual(paths(describeNode(node, {}, new Map(), {}, null, schemaSkill)), ['steps.ai.output.topic']);
    // The step's own schema wins; no skill known → the whole answer.
    const own = { ...node, outputSchema: { type: 'object', properties: { mine: { type: 'string' } } } };
    assert.deepStrictEqual(paths(describeNode(own, {}, new Map(), {}, null, catalog)), ['steps.ai.output.mine']);
    const bare = describeNode({ id: 'ai', type: 'ai_step' }, {}, new Map(), {}, null, null);
    assert.deepStrictEqual(bare.fields.map(f => [f.key, f.path]), [['response', 'steps.ai.output']]);
});

test('nested AI output schemas give element and child fields', () => {
    const node = { id: 'ai', type: 'ai_step', outputSchema: { type: 'object', properties: {
        invoices: { type: 'array', items: { type: 'object', properties: { amount: { type: 'number' }, vendor: { type: 'string' } } } },
        meta: { type: 'object', properties: { pages: { type: 'integer' } } },
    } } };
    assert.deepStrictEqual(paths(describeNode(node, {}, new Map(), {})), [
        'steps.ai.output.invoices', 'steps.ai.output.invoices[*].amount', 'steps.ai.output.invoices[*].vendor',
        'steps.ai.output.meta', 'steps.ai.output.meta.pages',
    ]);
});

test('a step after a Loop can pick what the body produced', () => {
    const g = group(computeUpstreamGroups(chain(), 'last', null), 'lp');
    assert.ok(paths(g).includes('steps.lp.output.results[*].output.summary'));
    const summary = allNodes(g.fields).find(f => f.path === 'steps.lp.output.results[*].output.summary');
    assert.deepStrictEqual(summary.sample, [1], 'the body resolved loop.row["Order ID"] against the element');
});

test('a batched Loop offers results[*].item[*].<field>, which resolves', () => {
    const def = chain();
    def.steps.find(s => s.id === 'lp').batchSize = 2;
    const g = group(computeUpstreamGroups(def, 'last', null), 'lp');
    assert.ok(paths(g).includes('steps.lp.output.results[*].item[*]["Order ID"]'));
    assert.ok(!paths(g).includes('steps.lp.output.results[*].item["Order ID"]'));
    const run = { steps: { lp: { output: { results: [{ item: [{ 'Order ID': 1 }, { 'Order ID': 2 }] }, { item: [{ 'Order ID': 3 }] }] } } } };
    assert.deepStrictEqual(walkPath('steps.lp.output.results[*].item[*]["Order ID"]', run), [1, 2, 3]);
});

test('a Loop body ending in a Wait offers what the step before it produced, never the Wait', () => {
    // Regression: the runner skips a Wait for lastOutput (runDag.js), so
    // results[*].output holds the previous step's output, not { waitedSeconds }.
    const def = chain();
    def.steps.find(s => s.id === 'lp').body.push({ id: 'b2', type: 'wait', seconds: 5 });
    const g = group(computeUpstreamGroups(def, 'last', null), 'lp');
    assert.ok(paths(g).includes('steps.lp.output.results[*].output.summary'));
    assert.ok(!paths(g).some(p => p.includes('waitedSeconds')));
    // A body of only a Wait yields null per iteration: no output fields at all.
    const onlyWait = chain();
    onlyWait.steps.find(s => s.id === 'lp').body = [{ id: 'w', type: 'wait', seconds: 5 }];
    const g2 = group(computeUpstreamGroups(onlyWait, 'last', null), 'lp');
    assert.ok(!paths(g2).some(p => p.startsWith('steps.lp.output.results[*].output')));
    assert.equal(g2.sample.results[0].output, null);
    // A last step with no describer: its output is unknown, so the earlier
    // step's fields are not offered in its place.
    const unknown = chain();
    unknown.steps.find(s => s.id === 'lp').body.push({ id: 'b9', type: 'not_a_described_type' });
    const g3 = group(computeUpstreamGroups(unknown, 'last', null), 'lp');
    assert.ok(!paths(g3).some(p => p.startsWith('steps.lp.output.results[*].output')));
});

test('a Loop body step with forEach is described in its envelope, inside the body and downstream', () => {
    // Regression: body steps dispatch forEach like top-level ones
    // (execution.js executeStepWithIteration), so their output is the
    // { iterations, succeeded, failed, results } envelope.
    const tools = { apps: [{ actions: [{ name: 'mail', outputSample: { subject: 'Hi' } }] }] };
    const def = chain();
    def.steps.find(s => s.id === 'lp').body.push(
        { id: 'b2', type: 'integration_action', tool: 'mail', forEach: { overRef: 'loop.row["line-items"]', itemVar: 'li' } },
    );
    const downstream = group(computeUpstreamGroups(def, 'last', tools), 'lp');
    assert.ok(!paths(downstream).includes('steps.lp.output.results[*].output.subject'));
    const real = 'steps.lp.output.results[*].output.results[*].output.subject';
    assert.ok(paths(downstream).includes(real), 'the envelope path is offered');
    const run = { steps: { lp: { output: { results: [{ output: { iterations: 1, results: [{ output: { subject: 'Hi' } }] } }] } } } };
    assert.deepStrictEqual(walkPath(real, run), ['Hi']);
    // Inside the body, the step after it sees the same envelope.
    const loop = def.steps.find(s => s.id === 'lp');
    loop.body.push({ id: 'b3', type: 'code' });
    const preview = { steps: { src: { output: { rows: ROWS } } } };
    const body = computeLoopBodyGroups(loop, 2, [], preview, tools, def);
    const b2 = group(body, 'b2');
    assert.equal(b2.forEach, true);
    assert.ok(paths(b2).includes('steps.b2.output.results[*].output.subject'));
    assert.ok(!paths(b2).includes('steps.b2.output.subject'));
});

test('real output that is a list or a string offers the whole output', () => {
    const base = describeNode({ id: 's', type: 'integration_action', tool: 'search' }, {}, buildToolOutputMap(null), {});
    const asText = overlayGroupWithReal(base, '# Markdown answer');
    assert.deepStrictEqual(asText.fields.map(f => [f.key, f.path, f.sample]), [['output', 'steps.s.output', '# Markdown answer']]);
    const asList = overlayGroupWithReal(base, [{ id: 1, 'Full name': 'Jan' }]);
    assert.equal(asList.fields[0].path, 'steps.s.output');
    assert.deepStrictEqual(asList.fields[0].children.map(c => c.path), ['steps.s.output[*].id', 'steps.s.output[*]["Full name"]']);
    // A string catalog sample offers the whole output before any run too.
    const md = describeNode({ id: 's', type: 'integration_action', tool: 'md' }, {}, new Map([['md', { sample: '<markdown>' }]]), {});
    assert.deepStrictEqual(md.fields.map(f => f.path), ['steps.s.output']);
});

test('steps inside a Loop body see the item, earlier body steps and the catalog', () => {
    const loop = {
        id: 'lp', type: 'loop', itemVar: 'row', overRef: 'steps.src.output.rows',
        body: [
            { id: 'b1', type: 'filter', arrayRef: 'loop.row["line-items"]' },
            { id: 'b2', type: 'datatable', datatableId: 'dt1' },
            { id: 'b3', type: 'code' },
        ],
    };
    const preview = { steps: { src: { output: { rows: ROWS } } } };
    const catalog = { datatables: [{ id: 'dt1', name: 'Klanten', columns: [{ key: 'naam', type: 'text' }] }] };
    const groups = computeLoopBodyGroups(loop, 2, [], preview, catalog, { steps: [] });
    assert.deepStrictEqual(groups.map(g => g.id), ['__loop_item', 'b1', 'b2']);
    assert.ok(paths(group(groups, '__loop_item')).includes('loop.row["Order ID"]'));
    assert.ok(paths(group(groups, 'b1')).includes('steps.b1.output.items[*]["unit price"]'), 'the filter resolved the loop item');
    assert.equal(group(groups, 'b2').label, 'Klanten', 'the catalog reached the body step');
    assert.ok(paths(group(groups, 'b2')).includes('steps.b2.output.rows[*].naam'));
});

test('Parse JSON in grouped mode opens its rows to the declared columns', () => {
    const node = { id: 'p', type: 'parse_json', itemsRef: 'meetings', fields: [{ name: 'meeting_title', path: 'title' }, { name: 'Start time', path: 'start' }] };
    assert.deepStrictEqual(paths(describeNode(node, {}, new Map(), {})), [
        'steps.p.output.items', 'steps.p.output.items[*].meeting_title', 'steps.p.output.items[*]["Start time"]', 'steps.p.output.count',
    ]);
});

test('static keys the real output lacks stay offered but unconfirmed', () => {
    const http = describeNode({ id: 'h', type: 'http_request' }, {}, new Map(), {});
    const g = overlayGroupWithReal(http, { status: 200, ok: true, headers: {}, body: '<html>', truncated: false });
    const confirmed = Object.fromEntries(g.fields.map(f => [f.key, f.confirmed]));
    assert.equal(confirmed.data, false);
    assert.equal(confirmed.body, true);
    assert.equal(g.hasRealData, true);
    // Curated paths the regeneration cannot derive survive, checked too.
    const sw = describeNode({ id: 'w', type: 'switch', cases: [{ name: 'Big order' }] }, {}, new Map(), {});
    const real = overlayGroupWithReal(sw, { matched: 'Big order', matchesByCase: { 'Big order': [{ a: 1 }] } });
    assert.equal(real.fields.find(f => f.path === 'steps.w.output.matchesByCase["Big order"]').confirmed, true);
    assert.equal(real.fields.find(f => f.path === 'steps.w.output.matchesByCase.default').confirmed, false);
});

test('loop item inference reads quoted keys through the catalog sample', () => {
    const def = { steps: [{ id: 's', type: 'integration_action', tool: 'x' }] };
    const tools = new Map([['x', { sample: { 'line-items': [{ sku: 'A' }] } }]]);
    assert.deepStrictEqual(inferLoopItemSample('steps.s.output["line-items"]', def, tools), { sku: 'A' });
    assert.equal(inferLoopItemSample('steps.s.output.line-items', def, tools), null);
});

test('collectArrayPaths writes overlay keys with the one quoting rule', () => {
    const groups = [{ basePath: 'steps.s.output', fields: [] }];
    assert.deepStrictEqual(
        collectArrayPaths(groups, { steps: { s: { output: { 'line-items': [1], 'a]b': [2] } } } }).map(a => a.path),
        ['steps.s.output["line-items"]'],
    );
});

test('the describer table covers the step types the builder describes', () => {
    for (const type of ['integration_action', 'ai_step', 'loop', 'loop_item', 'set', 'filter', 'parse_json', 'datatable', 'switch', 'form_page']) {
        assert.ok(DESCRIBED_TYPES.includes(type), type);
    }
    // A terminal step through the env: nothing can bind to it.
    const env = { isTerminalStepType: (t) => t === 'stop_error' };
    assert.equal(describeNode({ id: 'x', type: 'stop_error' }, {}, new Map(), {}, null, null, env), null);
});

test('group labels go through the env', () => {
    const env = { label: (key, fallback) => `${key}|${fallback}` };
    const def = { trigger: { id: 't', kind: 'webhook' }, steps: [{ id: 's', type: 'code' }, { id: 'n', type: 'code' }], edges: [{ from: 't', to: 's' }, { from: 's', to: 'n' }] };
    assert.deepStrictEqual(computeUpstreamGroups(def, 'n', null, null, env).map(g => g.label), ['trigger_webhook|Trigger (webhook)', 'node.code|Code']);
});

test('every node carries a Source whose last segment is its key', () => {
    for (const g of computeUpstreamGroups(chain(), 'last', null)) {
        for (const n of allNodes(g.fields)) {
            if (!n.source || n.source.path.length === 0) continue;
            const last = n.source.path[n.source.path.length - 1];
            if (!isWild(last) && n.key.indexOf('.') < 0) assert.equal(String(last), n.key, n.path);
        }
    }
});
