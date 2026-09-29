/**
 * POST /:id/publish ("Make vN live") and POST /:id/activate under the live
 * split (handoff 5). Handlers are called directly with an injected store —
 * no module mocking; validateDefinition is the real, pure validator.
 *
 * Proven:
 *   - publish validates the WORKING copy as strictly as activate and refuses
 *     a broken one;
 *   - publish is exact: a stale `version` (409) or a save that lands during the
 *     checks (store answers null → 409) publishes nothing;
 *   - publish moves the trigger columns with the live copy, arms the schedule
 *     only on an active routine, and re-registers triggers only when their
 *     configuration changed;
 *   - activate on a routine that HAS a live version only switches it on: it
 *     checks and registers the LIVE copy and never publishes pending changes.
 *
 * Run: cd server && node --test routes/automation/activate.publish.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { publishAutomation, activateAutomation } = require('./activate');

const MANUAL = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 's1', type: 'wait', seconds: 1 }], edges: [{ from: 't1', to: 's1' }] };
const SCHEDULED = { ...MANUAL, trigger: { id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } } };

function routine(overrides = {}) {
    const a = {
        id: 'a1', userId: 'u1', title: 'R', kind: 'automation', version: 4, isActive: true, isDraft: false,
        definition: MANUAL, liveVersion: 2, triggerType: 'manual', scheduleCron: null, scheduleTz: 'Europe/Amsterdam',
        ...overrides,
    };
    // The store hands the live copy out non-enumerable; so does this double.
    Object.defineProperty(a, 'liveDefinition', { value: overrides.liveDefinition ?? MANUAL, enumerable: false, writable: true });
    return a;
}

function harness(a, { publishResult } = {}) {
    const calls = { publish: [], update: [], subs: [], schedules: [], woke: [], forms: [] };
    const store = {
        getAutomation: async (id) => (a && id === a.id ? a : null),
        publishWorkingCopy: async (id, opts) => {
            calls.publish.push({ id, opts });
            return publishResult === undefined ? { ...a, liveVersion: opts.expectedVersion, pendingChanges: 0 } : publishResult;
        },
        updateAutomation: async (id, updates) => { calls.update.push(updates); return { ...a, ...updates }; },
        getSubscriptionsForAutomation: async () => [],
    };
    const deps = {
        store,
        agentsFor: async () => null,
        kbFindingsFor: async () => [],
        permittedApps: async () => new Set(),
        wakeComplianceReview: (x, reason) => calls.woke.push(reason),
        ensureFormPages: async (id) => calls.forms.push(id),
        syncAppEventSubscription: async (id, userId, def) => calls.subs.push(def),
        syncSchedules: async (id, def) => calls.schedules.push(def),
    };
    return { deps, calls };
}

function call(handler, deps, { params = { id: 'a1' }, body = {}, user = 'u1' } = {}) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); return this; },
        };
        const req = { params, body, session: { user: { id: user } } };
        Promise.resolve(handler(req, res, deps)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
}

test('publish: 404 for an unknown routine, 403 for someone else\'s', async () => {
    const { deps } = harness(routine());
    assert.strictEqual((await call(publishAutomation, deps, { params: { id: 'nope' } })).status, 404);
    assert.strictEqual((await call(publishAutomation, deps, { user: 'u2' })).status, 403);
});

test('publish: a stale version is refused before anything is checked or written', async () => {
    const { deps, calls } = harness(routine());
    const r = await call(publishAutomation, deps, { body: { version: 3 } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'version_changed');
    assert.strictEqual(r.body.version, 4);
    assert.strictEqual(calls.publish.length, 0);
});

test('publish: a broken working copy is refused like an activation', async () => {
    const { deps, calls } = harness(routine({ definition: {} }));
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'Invalid definition');
    assert.strictEqual(calls.publish.length, 0);
});

test('publish: exact version, trigger columns and schedule move with the live copy', async () => {
    const { deps, calls } = harness(routine({ definition: SCHEDULED }));
    const r = await call(publishAutomation, deps, { body: { version: 4 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.automation.liveVersion, 4);
    const { opts } = calls.publish[0];
    assert.strictEqual(opts.expectedVersion, 4);
    assert.strictEqual(opts.columns.triggerType, 'schedule');
    assert.strictEqual(opts.columns.scheduleCron, '0 7 * * 1-5');
    assert.ok(opts.columns.nextRunAt, 'an active routine is armed');
    assert.strictEqual(opts.columns.isDraft, false);
    // A PRIMARY schedule lives on the row's columns (moved above), so the
    // extra-schedule rows have nothing to re-register.
    assert.strictEqual(calls.schedules.length, 0);
    assert.deepStrictEqual(calls.woke, ['publish']);
    assert.deepStrictEqual(calls.forms, ['a1']);
});

test('publish: a paused routine is published but not armed', async () => {
    const a = routine({ definition: SCHEDULED, isActive: false });
    const { deps, calls } = harness(a, { publishResult: { ...a, liveVersion: 4, isActive: false } });
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls.publish[0].opts.columns.nextRunAt, null);
    assert.strictEqual(calls.schedules.length, 0, 'nothing is registered for a routine that is off');
    assert.strictEqual(calls.subs.length, 0);
});

test('publish: an extra schedule trigger that changed is re-registered from the live copy', async () => {
    const withExtra = { ...MANUAL, triggers: [{ id: 't2', kind: 'schedule', schedule: { cron: '0 9 * * *', tz: 'Europe/Amsterdam' } }] };
    const { deps, calls } = harness(routine({ definition: withExtra }));
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.schedules.length, 1);
    assert.deepStrictEqual(calls.schedules[0].triggers, withExtra.triggers);
});

test('publish: triggers are left alone when their configuration did not change', async () => {
    const { deps, calls } = harness(routine({ definition: { ...MANUAL, steps: [{ id: 's1', type: 'wait', seconds: 5 }] } }));
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls.schedules.length, 0);
    assert.strictEqual(calls.subs.length, 0);
});

test('publish: a save that lands during the checks publishes nothing (409)', async () => {
    const { deps, calls } = harness(routine(), { publishResult: null });
    const r = await call(publishAutomation, deps);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'version_changed');
    assert.strictEqual(calls.woke.length, 0);
});

test('activate on a routine with a live version only switches it on', async () => {
    // Working copy is broken; the LIVE copy is fine. Activation checks what
    // will run — the live copy — and does not publish the working copy.
    const a = routine({ definition: {}, isActive: false, liveDefinition: SCHEDULED, triggerType: 'schedule', scheduleCron: '0 7 * * 1-5' });
    const { deps, calls } = harness(a);
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.publish.length, 0, 'pending changes stay pending');
    assert.strictEqual(calls.update.length, 1);
    assert.strictEqual(calls.update[0].isActive, true);
    assert.ok(!('definition' in calls.update[0]));
    assert.ok(calls.update[0].nextRunAt);
    // Registered from the LIVE copy, the one that will run.
    assert.deepStrictEqual(calls.subs[0], SCHEDULED);
    assert.deepStrictEqual(calls.schedules[0], SCHEDULED);
});

test('activate on a never-live routine publishes exactly the version it checked', async () => {
    const a = routine({ definition: MANUAL, liveVersion: null, isActive: false, isDraft: true, version: 3 });
    const { deps, calls } = harness(a);
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(calls.publish.length, 1);
    assert.strictEqual(calls.publish[0].opts.expectedVersion, 3);
    assert.strictEqual(calls.publish[0].opts.columns.isActive, true);
    assert.strictEqual(calls.update.length, 0);

    // A save that landed after the checks: nothing goes live unchecked.
    const raced = harness(a, { publishResult: null });
    const r2 = await call(activateAutomation, raced.deps);
    assert.strictEqual(r2.status, 409);
    assert.strictEqual(r2.body.code, 'version_changed');
    assert.strictEqual(raced.calls.subs.length, 0);
});

test('activate on a never-live routine checks the working copy', async () => {
    const a = routine({ definition: {}, liveVersion: null, isActive: false, isDraft: true });
    const { deps, calls } = harness(a);
    const r = await call(activateAutomation, deps);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(calls.update.length, 0);
});
