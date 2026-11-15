/**
 * POST /:id/activate on an automation imported from Windmill
 * (automation/importGate.mts, wired in routes/automation/activate.js):
 *
 *   - an open checklist item → 409 import.windmill.placeholders_left, nothing changes;
 *   - checklist done but no dry run of THIS version → 409 import.windmill.dry_run_required;
 *   - both done → it goes live, and the gate is marked done (cleared);
 *   - an automation without an import row, or a store without import functions, is not gated.
 *
 * Run: cd server && node --test routes/automation/activate.importGate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { activateAutomation } = require('./activate');
const { HttpError } = require('../../core/http/errors');

const DEF = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 'p1', type: 'stop_error', label: 'Windmill: x', message: 'to convert' }], edges: [{ from: 't1', to: 'p1' }] };

function automation(overrides = {}) {
    const a = { id: 'a1', userId: 'u1', organizationId: 'org-1', title: 'R', kind: 'automation', version: 4, isActive: false, isDraft: true, definition: DEF, liveVersion: null, triggerType: 'manual', scheduleCron: null, scheduleTz: 'Europe/Amsterdam', ...overrides };
    Object.defineProperty(a, 'liveDefinition', { value: DEF, enumerable: false, writable: true });
    return a;
}

const importRow = (over = {}) => ({
    id: 'r1', automationId: 'a1', acknowledged: [], dryRunVersion: null, clearedAt: null,
    report: { aiChecklist: [{ wmId: 'p1', stepId: 'p1', placeholder: true, title: 'Convert p1' }] }, ...over,
});

function harness(a, row, { withImports = true } = {}) {
    const calls = { publish: [], cleared: [] };
    const store = {
        getAutomation: async (id) => (id === a.id ? a : null),
        publishWorkingCopy: async (id, opts) => { calls.publish.push(opts); return { ...a, liveVersion: opts.expectedVersion, isActive: true }; },
        updateAutomation: async (id, updates) => ({ ...a, ...updates }),
        getSubscriptionsForAutomation: async () => [],
        ...(withImports ? {
            getImportForAutomation: async () => row,
            markImportCleared: async (id) => { calls.cleared.push(id); },
        } : {}),
    };
    const deps = {
        store, agentsFor: async () => null, kbFindingsFor: async () => [], permittedApps: async () => new Set(),
        wakeComplianceReview: () => {}, syncAppEventSubscription: async () => {}, syncSchedules: async () => {},
        // The validator refuses a stop step on activation; this test is about the import gate only.
        validate: { validateDefinition: () => ({ ok: true, errors: [], warnings: [] }) },
    };
    return { deps, calls };
}

function run(deps) {
    let out = null;
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { out = { status: this.statusCode, body: b }; return this; } };
    return Promise.resolve(activateAutomation({ params: { id: 'a1' }, body: {}, session: { user: { id: 'u1' } } }, res, deps)).then(() => out);
}

test('an open checklist item refuses with its own code and changes nothing', async () => {
    const { deps, calls } = harness(automation(), importRow());
    await assert.rejects(run(deps), (e) => {
        assert.ok(e instanceof HttpError);
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.code, 'import.windmill.placeholders_left');
        assert.deepStrictEqual(e.details.open.map((o) => o.wmId), ['p1']);
        return true;
    });
    assert.strictEqual(calls.publish.length, 0);
});

test('an acknowledged checklist without a dry run of this version asks for one', async () => {
    const stale = harness(automation(), importRow({ acknowledged: ['p1'], dryRunVersion: 3 }));
    await assert.rejects(run(stale.deps), (e) => e.status === 409 && e.code === 'import.windmill.dry_run_required');
    assert.strictEqual(stale.calls.publish.length, 0);
});

test('checklist done and a dry run of this version: it goes live and the gate is done', async () => {
    const { deps, calls } = harness(automation(), importRow({ acknowledged: ['p1'], dryRunVersion: 4 }));
    const out = await run(deps);
    assert.strictEqual(out.status, 200);
    assert.strictEqual(calls.publish.length, 1);
    assert.deepStrictEqual(calls.cleared, ['a1']);
});

test('not imported, already cleared, or a store without imports: never gated', async () => {
    for (const [row, opts] of [[null, {}], [importRow({ clearedAt: '2026-11-15T00:00:00Z' }), {}], [importRow(), { withImports: false }]]) {
        const { deps } = harness(automation(), row, opts);
        assert.strictEqual((await run(deps)).status, 200);
    }
});
