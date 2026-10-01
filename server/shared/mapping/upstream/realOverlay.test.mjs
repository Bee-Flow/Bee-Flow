/**
 * realOverlay.mjs: real run or pinned output flowing into the upstream
 * groups, the fix for "I ran the step, it holds 10 records, and the node I
 * add after it still sees placeholders". computeUpstreamGroups' 4th argument
 * is optional and absent-off: without it the output stays as it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REF_RE } from '../legacy.mjs';
import { computeUpstreamGroups, overlayGroupWithReal } from './index.mjs';

const ROWS = [
    { subject: 'ISV contract', from_email: 'a@b.nl' },
    { subject: 'Pitch deck', from_email: 'c@d.nl' },
];

// An integration action the catalog knows NOTHING about (no outputSample):
// the exact case where the design-time describers produce an empty group.
const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 's1', type: 'integration_action', tool: 'gmail_search', label: 'gmail search', inputs: {} },
        { id: 'f1', type: 'filter', arrayRef: 'steps.s1.output.results' },
        { id: 'cur', type: 'notification', title: 'x' },
    ],
    edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'f1' }, { from: 'f1', to: 'cur' }],
};
const CATALOG = { apps: [], triggerOutputs: {} };
const real = () => new Map([['s1', { total: 2, results: ROWS }]]);
const withSteps = (steps, edges) => ({ ...DEF, steps, edges });

test('without the 4th argument nothing changes (regression pin)', () => {
    const before = computeUpstreamGroups(DEF, 'cur', CATALOG);
    const after = computeUpstreamGroups(DEF, 'cur', CATALOG, null);
    assert.deepStrictEqual(after, before);
    assert.ok(!after.some(g => g.hasRealData));
});

test('a run or pinned output fills the group sample AND its fields', () => {
    const g = computeUpstreamGroups(DEF, 'cur', CATALOG, real()).find(x => x.id === 's1');
    assert.equal(g.hasRealData, true);
    assert.deepStrictEqual(g.sample.results, ROWS);
    assert.equal(g.sample.total, 2);
    const resultsField = g.fields.find(f => f.key === 'results');
    assert.ok(Array.isArray(resultsField.sample));
    // A list of objects gets [*] children, so pickers and auto-map see the element shape.
    assert.deepStrictEqual(resultsField.children.map(c => c.path), [
        'steps.s1.output.results[*].subject',
        'steps.s1.output.results[*].from_email',
    ]);
});

test('downstream describers resolve their refs against the REAL upstream data', () => {
    const filter = computeUpstreamGroups(DEF, 'cur', CATALOG, real()).find(x => x.id === 'f1');
    assert.deepStrictEqual(filter.fields.find(f => f.key === 'items').children.map(c => c.key), ['subject', 'from_email']);
    assert.deepStrictEqual(filter.sample.items[0], ROWS[0]);
});

test('a real JSON body replaces an http placeholder string wholesale', () => {
    const def = withSteps(
        [{ id: 'h1', type: 'http_request', url: 'https://x', method: 'GET' }, { id: 'cur', type: 'notification', title: 'x' }],
        [{ from: 'trg', to: 'h1' }, { from: 'h1', to: 'cur' }],
    );
    const g = computeUpstreamGroups(def, 'cur', CATALOG, new Map([['h1', { status: 200, body: ROWS }]])).find(x => x.id === 'h1');
    const body = g.fields.find(f => f.key === 'body');
    assert.ok(Array.isArray(body.sample));
    assert.ok(body.children.some(c => c.path === 'steps.h1.output.body[*].subject'));
});

test('a fired trigger is not clobbered by a second trigger group', () => {
    const def = { ...DEF, triggers: [{ id: 'hook', kind: 'webhook' }] };
    const groups = computeUpstreamGroups(def, 'cur', CATALOG, new Map([['trg', { fired: true, n: 1 }]]));
    const primary = groups.find(g => g.id === 'trg');
    assert.equal(primary.hasRealData, true);
    assert.equal(primary.sample.fired, true);
    // The webhook group still describes ITSELF as a placeholder.
    assert.ok(!groups.find(g => g.id === 'hook').hasRealData);
});

test('non-object real output (raw AI text) keeps a field list', () => {
    const def = withSteps(
        [{ id: 'ai1', type: 'ai_step', prompt: 'x' }, { id: 'cur', type: 'notification', title: 'x' }],
        [{ from: 'trg', to: 'ai1' }, { from: 'ai1', to: 'cur' }],
    );
    const g = computeUpstreamGroups(def, 'cur', CATALOG, new Map([['ai1', 'plain model answer']])).find(x => x.id === 'ai1');
    assert.equal(g.hasRealData, true);
    assert.equal(g.sample, 'plain model answer');
    assert.ok(Array.isArray(g.fields));
});

test('a forEach envelope overlays the WRAPPED group, not the flat tool shape', () => {
    const def = withSteps(
        [
            { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            { id: 'fe', type: 'integration_action', tool: 'send_mail', inputs: {}, forEach: { overRef: 'steps.s1.output.results', itemVar: 'item' } },
            { id: 'cur', type: 'notification', title: 'x' },
        ],
        [{ from: 'trg', to: 's1' }, { from: 's1', to: 'fe' }, { from: 'fe', to: 'cur' }],
    );
    const envelope = { iterations: 2, succeeded: 2, failed: 0, results: [{ index: 0, item: ROWS[0], output: { ok: true }, status: 'success' }] };
    const g = computeUpstreamGroups(def, 'cur', CATALOG, new Map([['fe', envelope]])).find(x => x.id === 'fe');
    assert.equal(g.sample.iterations, 2);
    assert.equal(g.sample.results[0].output.ok, true);
});

// ── overlayGroupWithReal ────────────────────────────────

const GROUP = {
    id: 's1', kind: 'integration_action', basePath: 'steps.s1.output',
    sample: { results: [] },
    fields: [
        { key: 'results', path: 'steps.s1.output.results', sample: [] },
        // A curated path regeneration can't derive:
        { key: 'special', path: 'steps.s1.output.matchesByCase.vip', sample: [] },
    ],
};

test('overlayGroupWithReal keeps curated fields whose paths regeneration does not cover', () => {
    assert.ok(overlayGroupWithReal(GROUP, { results: ROWS }).fields.some(f => f.path === 'steps.s1.output.matchesByCase.vip'));
});

test('overlayGroupWithReal reuses real row references (no cloning of big outputs)', () => {
    assert.equal(overlayGroupWithReal(GROUP, { results: ROWS }).sample.results, ROWS);
});

test('overlayGroupWithReal with an undefined real output is a no-op', () => {
    assert.equal(overlayGroupWithReal(GROUP, undefined), GROUP);
});

test('overlayGroupWithReal brackets keys too, including the [*] element level', () => {
    const group = overlayGroupWithReal(
        { id: 's1', label: 'HTTP', kind: 'http_request', basePath: 'steps.s1.output', sample: {}, fields: [] },
        { 'line-items': [{ 'unit price': 3, sku: 'a1' }] },
    );
    const f = group.fields.find(x => x.key === 'line-items');
    assert.equal(f.path, 'steps.s1.output["line-items"]');
    const childPaths = Object.fromEntries(f.children.map(c => [c.key, c.path]));
    assert.equal(childPaths['unit price'], 'steps.s1.output["line-items"][*]["unit price"]');
    assert.equal(childPaths.sku, 'steps.s1.output["line-items"][*].sku');
    for (const p of [f.path, ...Object.values(childPaths)]) assert.ok(REF_RE.test(p), p);
});
