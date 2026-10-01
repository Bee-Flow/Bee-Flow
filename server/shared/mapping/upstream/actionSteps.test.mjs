/**
 * actionSteps.mjs: the notification and privacy steps offer what their
 * executors really return (node-audit C22), and nothing they do not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUpstreamGroups } from './index.mjs';

const catalog = {
    apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ subject: 'Re: hi', from: 'a@b.c' }] } }] }],
    triggerOutputs: { __manual: { fields: [], sample: {} } },
};
const defWith = (steps, edges) => ({ trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps, edges });

test('notification offers delivered.title/body/channels and no phantom `sent`', () => {
    const def = defWith(
        [{ id: 'nt1', type: 'notification', title: 'Hi' }, { id: 'n2', type: 'notification', title: 't' }],
        [{ from: 'trg', to: 'nt1' }, { from: 'nt1', to: 'n2' }],
    );
    const paths = computeUpstreamGroups(def, 'n2', catalog).find(g => g.id === 'nt1').fields.map(f => f.path);
    assert.ok(paths.some(p => p.includes('delivered')));
    assert.ok(!paths.some(p => p.endsWith('.sent')));
});

// Without a describer the privacy steps produced NO group, so a "Show real
// values again" dropped straight after "Hide personal data" could not be
// pointed at the very value it exists to restore.
const chain = (type, label) => defWith(
    [
        { id: 'g1', type: 'integration_action', tool: 'gmail_search', inputs: {} },
        { id: 'p1', type, sourceRef: 'steps.g1.output.results', label },
        { id: 'n1', type: 'notification', title: 't' },
    ],
    [{ from: 'trg', to: 'g1' }, { from: 'g1', to: 'p1' }, { from: 'p1', to: 'n1' }],
);
const privacyGroup = (type, label) => computeUpstreamGroups(chain(type, label), 'n1', catalog).find(g => g.id === 'p1');

test('tokenize offers output.text, the value everything downstream binds to', () => {
    const g = privacyGroup('tokenize', 'Hide personal data');
    assert.equal(g.label, 'Hide personal data');
    const paths = g.fields.map(f => f.path);
    assert.ok(paths.includes('steps.p1.output.text'));
    assert.ok(paths.includes('steps.p1.output.count'));
});

test('untokenize offers what it restored, and what it could not', () => {
    const paths = privacyGroup('untokenize', 'Show real values again').fields.map(f => f.path);
    for (const p of ['steps.p1.output.text', 'steps.p1.output.restored', 'steps.p1.output.unresolved']) assert.ok(paths.includes(p), p);
});

test('guard offers the branch and what it found', () => {
    const paths = privacyGroup('guard', 'Check for personal data').fields.map(f => f.path);
    for (const p of ['steps.p1.output.branch', 'steps.p1.output.hasPii', 'steps.p1.output.count']) assert.ok(paths.includes(p), p);
});
