/**
 * The projects module's producer of the one Finding shape (./finding.js): the Solution dependency graph
 * converts into Findings without a per-producer adapter. The shape itself is
 * finding.test.js.
 *
 * Run: node --test --test-force-exit core/findings/finding.projects.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fromLegacy, isFinding } = require('./finding');

test('Solution graph: a problem is a Finding about the object that HOLDS the broken reference', () => {
    const { buildProjectGraph, PROBLEM, PROSE, SEVERITY } = require('../../projects/graph');
    assert.equal(typeof PROSE[PROBLEM.UNWIRED], 'function', 'PROSE stays exported');

    const g = buildProjectGraph({
        automations: [
            { id: 'a1', title: 'Kredietcheck', userId: 'alice', kind: 'automation', definition: { steps: [{ id: 'call_1', type: 'call_block', blockId: 'gone' }] } },
        ],
        apps: [{ id: 'app1', name: 'Offerteportaal', userId: 'alice', definition: { actions: { go: { kind: 'run_automation', automationId: null } } } }],
        webpages: [{ id: 'w1', name: 'Landing', userId: 'alice', bridgeGrants: { automations: [{ automationId: 'elsewhere' }] } }],
        knownAutomationIds: new Set(['elsewhere']),
    });

    const byCode = Object.fromEntries(g.problems.map((p) => [p.code, p]));
    assert.deepEqual(Object.keys(byCode).sort(), [PROBLEM.EXTERNAL, PROBLEM.MISSING, PROBLEM.UNWIRED]);

    const unwired = byCode[PROBLEM.UNWIRED];
    assert.equal(unwired.kind, 'app');
    assert.deepEqual(unwired.targetRef, { kind: 'app', id: 'app1', title: 'Offerteportaal' });
    assert.equal(unwired.severity, SEVERITY[PROBLEM.UNWIRED]);
    assert.equal(unwired.message, PROSE[PROBLEM.UNWIRED]('Offerteportaal'), 'the prose is rendered at construction');
    assert.equal(unwired.targetId, null, 'the graph\'s own fields are untouched');

    const missing = byCode[PROBLEM.MISSING];
    assert.equal(missing.kind, 'automation');
    assert.deepEqual(missing.targetRef, { kind: 'automation', id: 'a1', title: 'Kredietcheck', stepId: 'call_1' });
    assert.equal(missing.targetId, 'gone', 'targetId is still the automation pointed AT, not the Finding target');
    assert.equal(missing.severity, 'error');

    const external = byCode[PROBLEM.EXTERNAL];
    assert.deepEqual(external.targetRef, { kind: 'webpage', id: 'w1', title: 'Landing' });

    for (const p of g.problems) {
        const f = fromLegacy(p.kind, p);
        assert.ok(isFinding(f), `${p.code} converts`);
        assert.equal(f.message, p.message);
    }
});
