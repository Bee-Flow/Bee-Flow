/**
 * triggers.mjs: an app_trigger's declared params surface as
 * `trigger.output.<name>` bindables (the same declared-params path as
 * layer_input), with a file param expanding to its runtime
 * `{ fileId, name, mime, size, url }` shape so `trigger.output.<name>.url`
 * is bindable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUpstreamGroups } from './index.mjs';

const CATALOG = { triggerOutputs: { __manual: { fields: [{ key: 'now', sample: 'x' }], sample: { now: 'x' } } } };

function definitionWith(params) {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'app_trigger', params },
        steps: [{ id: 's1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
}

test('declared params become trigger.output.<name> fields without a catalog round-trip', () => {
    const groups = computeUpstreamGroups(definitionWith([
        { name: 'title', type: 'string', required: true },
        { name: 'amount', type: 'number' },
    ]), 's1', CATALOG);
    const trig = groups.find(g => g.kind === 'trigger');
    assert.equal(trig.label, 'Studio App inputs');
    const paths = trig.fields.map(f => f.path);
    assert.ok(paths.includes('trigger.output.title'));
    assert.ok(paths.includes('trigger.output.amount'));
    // NOT the __manual fallback.
    assert.ok(!paths.includes('trigger.output.now'));
});

test('a file param samples as the expanded runtime shape (url bindable)', () => {
    const groups = computeUpstreamGroups(definitionWith([
        { name: 'doc', type: 'file', required: true },
    ]), 's1', CATALOG);
    const trig = groups.find(g => g.kind === 'trigger');
    const doc = trig.fields.find(f => f.key === 'doc');
    assert.equal(doc.sample.mime, 'application/pdf');
    for (const k of ['fileId', 'name', 'mime', 'size', 'url']) assert.ok(k in doc.sample, k);
    assert.ok(trig.sample.doc.url);
});
