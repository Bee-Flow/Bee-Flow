/**
 * collectionSteps.mjs: the list nodes (Filter, Aggregate, Set in list mode,
 * Parse JSON) resolve their element shapes through the accumulated sample
 * root, so a step after them is offered the real columns.
 *
 * The Set step's column operations and the Date & time step's list mode come
 * from the client's env; agent-hub tests those through its BUILDER_ENV
 * (Builder/mapping/upstream.env.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUpstreamGroups, describeNode, buildToolOutputMap } from './index.mjs';

const pick = ({ key, path, sample }) => ({ key, path, sample });

// ── Filter / Aggregate ──────────────────────────────────

const OPS_CATALOG = {
    apps: [{ id: 'x', actions: [{ name: 't1', outputSample: { results: [{ email: 'a@b.c', amount: 5 }] } }] }],
    triggerOutputs: {},
};
const opsDefinition = (stepB) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'A', type: 'integration_action', tool: 't1', inputs: {} },
        stepB,
        { id: 'C', type: 'set', fields: {} },
    ],
    edges: [{ from: 'trg', to: 'A' }, { from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
});

test('a filter group carries the source element inside items, with items[*] children', () => {
    const groups = computeUpstreamGroups(opsDefinition({ id: 'B', type: 'filter', arrayRef: 'steps.A.output.results' }), 'C', OPS_CATALOG);
    // Topological order: trigger, A, B (nearest last).
    assert.deepStrictEqual(groups.map(g => g.id), ['trg', 'A', 'B']);
    const filterGroup = groups.find(g => g.id === 'B');
    assert.deepStrictEqual(filterGroup.sample, { items: [{ email: 'a@b.c', amount: 5 }], count: 0 });
    const items = filterGroup.fields.find(f => f.key === 'items');
    assert.deepStrictEqual(items.children.map(pick), [
        { key: 'email', path: 'steps.B.output.items[*].email', sample: 'a@b.c' },
        { key: 'amount', path: 'steps.B.output.items[*].amount', sample: 5 },
    ]);
});

test('an aggregate group plucks the configured field into values', () => {
    const groups = computeUpstreamGroups(opsDefinition({ id: 'B', type: 'aggregate', arrayRef: 'steps.A.output.results', field: 'email' }), 'C', OPS_CATALOG);
    assert.deepStrictEqual(groups.find(g => g.id === 'B').sample, { values: ['a@b.c'], count: 0 });
});

// ── Set (node-audit C25) ────────────────────────────────

const GMAIL = {
    apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ subject: 'Re: hi', from: 'a@b.c' }] } }] }],
    triggerOutputs: { __manual: { fields: [], sample: {} } },
};
const setDef = (setStep) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'g1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
        setStep,
        { id: 'after', type: 'notification', title: 't' },
    ],
    edges: [{ from: 'trg', to: 'g1' }, { from: 'g1', to: setStep.id }, { from: setStep.id, to: 'after' }],
});
const setGroup = (setStep) => computeUpstreamGroups(setDef(setStep), 'after', GMAIL).find(g => g.id === setStep.id);

test('Set resolves a ref-bound field to the REAL upstream sample (arrays become visible)', () => {
    const g = setGroup({ id: 'set1', type: 'set', fields: { rows: { kind: 'ref', path: 'steps.g1.output.results' }, note: { kind: 'literal', value: 'x' } } });
    assert.ok(Array.isArray(g.fields.find(f => f.key === 'rows').sample));
    assert.equal(g.fields.find(f => f.key === 'note').sample, 'x');
});

test('Set in list mode offers the {items, count} envelope with source columns and computed fields per row', () => {
    const g = setGroup({
        id: 's1', type: 'set', arrayRef: 'steps.g1.output.results',
        fields: { sender: { kind: 'ref', path: 'item.from' } },
    });
    assert.equal(g.basePath, 'steps.s1.output');
    const paths = g.fields.map(f => f.path);
    assert.ok(paths.includes('steps.s1.output.items'));
    assert.ok(paths.includes('steps.s1.output.count'));
    const items = g.fields.find(f => f.key === 'items');
    const childPaths = items.children.map(c => c.path);
    assert.ok(childPaths.includes('steps.s1.output.items[*].subject'), 'source column survives');
    assert.ok(childPaths.includes('steps.s1.output.items[*].sender'), 'computed field added');
    // The item.* ref resolved against the element sample, not a placeholder.
    assert.equal(items.children.find(c => c.key === 'sender').sample, 'a@b.c');
});

test('Set in list mode with an unresolvable source yields the bare envelope', () => {
    const g = setGroup({ id: 's1', type: 'set', arrayRef: 'steps.g1.output.ghost', fields: {} });
    assert.deepStrictEqual(g.sample, { items: [], count: 0 });
});

// ── Parse JSON ──────────────────────────────────────────

const parseNode = (over = {}) => ({
    id: 'p1',
    type: 'parse_json',
    label: 'Parse order',
    sourceRef: 'steps.h1.output.body',
    mode: 'paths',
    fields: [
        { name: 'email', path: 'order.customer.email' },
        { name: 'skus', path: 'items[*].sku' },
        { name: 'missing', path: 'nope.x', fallback: 'n/a' },
    ],
    ...over,
});
const describeParse = (n, sampleRoot = null) => describeNode(n, {}, buildToolOutputMap(null), {}, sampleRoot);

test('Parse JSON without a sample root: flat <extracted> sample honouring fallbacks', () => {
    const g = describeParse(parseNode());
    assert.equal(g.kind, 'parse_json');
    assert.equal(g.basePath, 'steps.p1.output');
    assert.deepStrictEqual(g.sample, { email: '<extracted>', skus: '<extracted>', missing: 'n/a' });
    assert.deepStrictEqual(g.fields.map(f => f.path), ['steps.p1.output.email', 'steps.p1.output.skus', 'steps.p1.output.missing']);
});

test('Parse JSON resolves real values from the sample root (a string source is parsed)', () => {
    const sampleRoot = {
        trigger: { output: {} },
        steps: { h1: { output: { body: '{"order":{"customer":{"email":"a@b.c"}},"items":[{"sku":"X1"},{"sku":"X2"}]}' } } },
    };
    assert.deepStrictEqual(describeParse(parseNode(), sampleRoot).sample, { email: 'a@b.c', skus: ['X1', 'X2'], missing: 'n/a' });
});

test('Parse JSON skips rows without a name; the label falls back to Parse JSON', () => {
    const g = describeParse(parseNode({ label: '', fields: [{ name: '', path: 'x' }, null, { name: 'ok', path: 'y' }] }));
    assert.equal(g.label, 'Parse JSON');
    assert.deepStrictEqual(Object.keys(g.sample), ['ok']);
});

test('Parse JSON surfaces as a bindable upstream group for a downstream step', () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'h1', type: 'http_request', url: 'https://api.example.com' },
            parseNode(),
            { id: 'n1', type: 'notification', title: 'x' },
        ],
        edges: [{ from: 'trg', to: 'h1' }, { from: 'h1', to: 'p1' }, { from: 'p1', to: 'n1' }],
    };
    const g = computeUpstreamGroups(def, 'n1', {}).find(x => x.id === 'p1');
    assert.deepStrictEqual(g.fields.map(f => f.key), ['email', 'skus', 'missing']);
});

const CAL = {
    steps: {
        c1: {
            output: {
                results: [
                    { title: 'Daily Scrum', attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }] },
                    { title: 'Weekstart', attendees: [{ email: 'c@x.nl' }] },
                ],
            },
        },
    },
};
const grouped = parseNode({
    sourceRef: 'steps.c1.output',
    itemsRef: 'results',
    fields: [
        { name: 'meeting_title', path: 'title' },
        { name: 'attendee_emails', path: 'attendees[*].email' },
    ],
});

test('grouped Parse JSON exposes { items, count }, each row keeping its own values', () => {
    const g = describeParse(grouped, CAL);
    assert.equal(g.basePath, 'steps.p1.output');
    assert.equal(g.sample.count, 2);
    assert.deepStrictEqual(g.sample.items[0], { meeting_title: 'Daily Scrum', attendee_emails: ['a@x.nl', 'b@x.nl'] });
    assert.deepStrictEqual(g.sample.items[1], { meeting_title: 'Weekstart', attendee_emails: ['c@x.nl'] });
    assert.ok(g.fields.some(f => f.path === 'steps.p1.output.items'));
});

test('grouped Parse JSON falls back to one placeholder row without a resolvable sample', () => {
    const g = describeParse(grouped, null);
    assert.equal(g.sample.items.length, 1);
    assert.equal(g.sample.items[0].meeting_title, '<extracted>');
});
