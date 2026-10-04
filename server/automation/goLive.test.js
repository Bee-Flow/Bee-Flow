/**
 * automation/goLive.js — the go-live decisions and side effects without HTTP.
 * Every collaborator is injected (no module mocking); validateDefinition,
 * the schedule helpers and the fingerprints are the real, pure ones.
 *
 * Proven:
 *   - planGoLive moves the trigger columns, arms a schedule only for an automation
 *     that is or will be active, refuses a bad or unreachable cron with
 *     `invalid_schedule`, and carries runTimeoutMs and isDraft:false;
 *   - activateCore writes exactly the update set POST /:id/activate writes;
 *   - deactivateCore revokes remote subscriptions BEFORE deleting the rows;
 *   - convergeAfterPublish re-registers triggers only on a fingerprint change
 *     of an active automation, runs the usage and KB-source syncs, and never
 *     throws;
 *   - checkBeforeLiveCore refuses a broken definition, KB findings, and hands
 *     the AI Act refusal back as `raise`.
 *
 * Run: cd server && node --test automation/goLive.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { planGoLive, activateCore, deactivateCore, convergeAfterPublish, checkBeforeLiveCore, refusalError } = require('./goLive');
const { activateAutomation } = require('../routes/automation/activate');

const MANUAL = { trigger: { id: 't1', kind: 'manual' }, steps: [{ id: 's1', type: 'wait', seconds: 1 }], edges: [{ from: 't1', to: 's1' }] };
const SCHEDULED = { ...MANUAL, trigger: { id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } } };
const NOW = Date.parse('2026-10-05T05:00:00Z'); // a Monday, before 07:00 Amsterdam

function automation(overrides = {}) {
    const a = {
        id: 'a1', userId: 'u1', title: 'R', kind: 'automation', version: 4, isActive: false, isDraft: true,
        definition: MANUAL, liveVersion: null, triggerType: 'manual', scheduleCron: null, scheduleTz: 'Europe/Amsterdam',
        ...overrides,
    };
    Object.defineProperty(a, 'liveDefinition', { value: overrides.liveDefinition ?? MANUAL, enumerable: false, writable: true });
    return a;
}

/** A store double plus the collaborators a core writes through, all recording. */
function harness(a, { publishResult } = {}) {
    const calls = { order: [], publish: [], update: [], subs: [], schedules: [], woke: [], forms: [], usage: [], kb: [], answers: [], dispatched: [] };
    const store = {
        getAutomation: async (id) => (a && id === a.id ? a : null),
        publishWorkingCopy: async (id, opts) => {
            calls.publish.push(opts);
            return publishResult === undefined ? { ...a, ...opts.columns, liveVersion: opts.expectedVersion } : publishResult;
        },
        updateAutomation: async (id, updates, actor) => { calls.order.push('update'); calls.update.push({ updates, actor }); return { ...a, ...updates }; },
        deleteSubscriptionsForAutomation: async () => { calls.order.push('delete'); },
        getSubscriptionsForAutomation: async () => [],
    };
    const deps = {
        store,
        agentsFor: async () => null,
        kbFindingsFor: async () => [],
        permittedApps: async () => new Set(),
        wakeComplianceReview: (x, reason) => calls.woke.push(reason),
        ensureFormPages: async (id) => calls.forms.push(id),
        ensureAnswersTable: async () => { calls.answers.push(1); return { answers: { datatableId: 'dt1' }, usage: [{ datatableId: 'dt1', stepId: 'trigger:form', mode: 'write', columns: [] }] }; },
        syncAppEventSubscription: async (id, ownerId, def) => calls.subs.push({ ownerId, def }),
        syncSchedules: async (id, def, opts) => calls.schedules.push({ def, opts }),
        syncDatatableUsage: async (id, orgId, def, opts) => calls.usage.push({ id, orgId, opts }),
        syncKbSources: async (id, def, opts) => calls.kb.push({ id, opts }),
        revokeRemoteSubscriptions: async (id, ownerId) => { calls.order.push(`revoke:${ownerId}`); },
        triggerBus: { fetchLatestGmailMatch: async () => null },
        dispatch: { dispatchToSubscription: (sub) => calls.dispatched.push(sub.id) },
        now: () => NOW,
    };
    return { deps, calls, store };
}

// ── planGoLive ──────────────────────────────────────────────────────

test('planGoLive: a schedule moves its columns and is armed for an active automation', () => {
    const r = planGoLive(automation(), SCHEDULED, { now: NOW, willBeActive: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.columns.triggerType, 'schedule');
    assert.strictEqual(r.columns.scheduleCron, '0 7 * * 1-5');
    assert.strictEqual(r.columns.scheduleTz, 'Europe/Amsterdam');
    assert.ok(r.columns.nextRunAt instanceof Date || typeof r.columns.nextRunAt === 'string' || typeof r.columns.nextRunAt === 'number',
        'an active automation gets its next slot');
    assert.ok(new Date(r.columns.nextRunAt).getTime() > NOW);
    assert.strictEqual(r.columns.isDraft, false);
    assert.ok(!('runTimeoutMs' in r.columns), 'no policy, no timeout column');
});

test('planGoLive: no nextRunAt for an automation that is not and will not be active', () => {
    const paused = planGoLive(automation({ isActive: false }), SCHEDULED, { now: NOW });
    assert.strictEqual(paused.ok, true);
    assert.strictEqual(paused.columns.nextRunAt, null);
    const willNot = planGoLive(automation({ isActive: true }), SCHEDULED, { now: NOW, willBeActive: false });
    assert.strictEqual(willNot.columns.nextRunAt, null);
    // A manual automation clears the slot either way.
    assert.strictEqual(planGoLive(automation({ isActive: true }), MANUAL, { now: NOW }).columns.nextRunAt, null);
});

test('planGoLive: a bad cron and an unreachable one are 400 invalid_schedule', () => {
    const bad = { ...MANUAL, trigger: { id: 't1', kind: 'schedule', schedule: { cron: 'not a cron', tz: 'Europe/Amsterdam' } } };
    const r = planGoLive(automation(), bad, { now: NOW, willBeActive: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.code, 'invalid_schedule');
    assert.match(r.message, /^Cannot publish: the schedule "not a cron" is not valid/);
    assert.deepStrictEqual(r.body, { error: r.message, code: 'invalid_schedule' });

    const feb31 = { ...MANUAL, trigger: { id: 't1', kind: 'schedule', schedule: { cron: '0 0 31 2 *', tz: 'Europe/Amsterdam' } } };
    const u = planGoLive(automation(), feb31, { now: NOW, willBeActive: false });
    assert.strictEqual(u.ok, false, 'refused even for a paused automation: it could never fire');
    assert.strictEqual(u.code, 'invalid_schedule');
    assert.match(u.message, /has no upcoming run time/);
});

test('planGoLive: verb activate reads the ROW\'s schedule and answers in the activate wording', () => {
    const a = automation({ triggerType: 'schedule', scheduleCron: 'not a cron' });
    const r = planGoLive(a, MANUAL, { now: NOW, willBeActive: true, verb: 'activate' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'invalid_schedule');
    assert.deepStrictEqual(r.body, { error: r.message }, 'the activate route has always answered without a code');
    assert.match(r.message, /^Cannot activate — invalid schedule "not a cron"/);

    const ok = planGoLive(automation({ triggerType: 'schedule', scheduleCron: '0 7 * * 1-5' }), MANUAL, { now: NOW, willBeActive: true, verb: 'activate' });
    assert.ok(ok.columns.nextRunAt, 'the row\'s schedule is armed');
    assert.ok(!('triggerType' in ok.columns), 'activate writes no trigger columns');
});

test('planGoLive: a runPolicy sets runTimeoutMs', () => {
    const r = planGoLive(automation(), { ...MANUAL, runPolicy: { maxDurationMin: 5 } }, { now: NOW });
    assert.strictEqual(r.columns.runTimeoutMs, 5 * 60 * 1000);
});

// ── activateCore ────────────────────────────────────────────────────

function callRoute(handler, deps, a) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); return this; },
        };
        const req = { params: { id: a.id }, body: {}, session: { user: { id: 'u1' } } };
        Promise.resolve(handler(req, res, deps)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
}

test('activateCore writes the same update set as POST /:id/activate (paused automation with a live copy)', async () => {
    // runPolicy is a SETTING: it comes from the working copy even on a live
    // run (core/automationRunner/definitionForRun.js), so it sits there.
    const policy = { maxDurationMin: 5 };
    const live = { ...SCHEDULED, runPolicy: policy };
    const make = () => automation({
        definition: { ...MANUAL, runPolicy: policy }, liveVersion: 2, liveDefinition: SCHEDULED,
        triggerType: 'schedule', scheduleCron: '0 7 * * 1-5',
    });

    const core = harness(make());
    const r = await activateCore({ automation: make(), actorId: 'u1', deps: core.deps });
    assert.strictEqual(r.ok, true, JSON.stringify(r));

    const route = harness(make());
    const out = await callRoute(activateAutomation, route.deps, make());
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));

    const coreUpdate = core.calls.update[0].updates;
    const routeUpdate = route.calls.update[0].updates;
    assert.deepStrictEqual(Object.keys(coreUpdate).sort(), Object.keys(routeUpdate).sort());
    assert.deepStrictEqual(Object.keys(coreUpdate).sort(), ['isActive', 'isDraft', 'needsFirstRunConfirm', 'nextRunAt', 'runTimeoutMs']);
    assert.strictEqual(coreUpdate.isActive, true);
    assert.strictEqual(coreUpdate.isDraft, false);
    assert.strictEqual(coreUpdate.needsFirstRunConfirm, false);
    assert.strictEqual(coreUpdate.runTimeoutMs, 5 * 60 * 1000);
    assert.strictEqual(routeUpdate.runTimeoutMs, coreUpdate.runTimeoutMs);
    assert.strictEqual(core.calls.update[0].actor, 'u1');
    assert.strictEqual(core.calls.publish.length, 0, 'pending changes stay pending');

    // Registered from the LIVE copy, re-armed, and compliance told.
    assert.deepStrictEqual(core.calls.subs[0].def, live);
    assert.deepStrictEqual(core.calls.schedules[0], { def: live, opts: { rearm: true } });
    assert.deepStrictEqual(core.calls.woke, ['activation']);
    assert.deepStrictEqual(r.automation.isActive, true);
});

test('activateCore on a never-live automation publishes exactly the checked version, with the same columns', async () => {
    const make = () => automation({ definition: { ...MANUAL, runPolicy: { maxDurationMin: 2 } }, version: 3 });
    const core = harness(make());
    const r = await activateCore({ automation: make(), actorId: 'u1', deps: core.deps });
    assert.strictEqual(r.ok, true);
    const route = harness(make());
    await callRoute(activateAutomation, route.deps, make());

    assert.strictEqual(core.calls.publish[0].expectedVersion, 3);
    const { nextRunAt: _a, ...coreCols } = core.calls.publish[0].columns;
    const { nextRunAt: _b, ...routeCols } = route.calls.publish[0].columns;
    assert.deepStrictEqual(coreCols, routeCols);
    assert.deepStrictEqual(coreCols, { isActive: true, isDraft: false, needsFirstRunConfirm: false, runTimeoutMs: 2 * 60 * 1000 });
    assert.strictEqual(core.calls.update.length, 0);
});

test('activateCore refuses a race (409 version_changed) and registers nothing', async () => {
    const a = automation();
    const { deps, calls } = harness(a, { publishResult: null });
    const r = await activateCore({ automation: a, actorId: 'u1', deps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.code, 'version_changed');
    assert.deepStrictEqual(r.body, { error: r.message, code: 'version_changed' });
    assert.strictEqual(calls.subs.length, 0);
    assert.strictEqual(calls.woke.length, 0);
});

test('activateCore refuses a broken definition with the route\'s body and writes nothing', async () => {
    const a = automation({ definition: {} });
    const { deps, calls } = harness(a);
    const r = await activateCore({ automation: a, actorId: 'u1', deps });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'Invalid definition');
    assert.ok(Array.isArray(r.body.details));
    assert.strictEqual(calls.publish.length + calls.update.length, 0);
});

test('activateCore dispatches the Gmail catch-up to this automation\'s own subscription', async () => {
    const a = automation();
    const { deps, calls, store } = harness(a);
    store.getSubscriptionsForAutomation = async () => [
        { id: 'sub-g', provider: 'gmail', eventType: 'mail.new', filter: null },
        { id: 'sub-x', provider: 'slack', eventType: 'message', filter: null },
    ];
    deps.triggerBus = { fetchLatestGmailMatch: async () => ({ id: 'm1' }) };
    await activateCore({ automation: a, actorId: 'u1', deps });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(calls.dispatched, ['sub-g']);
});

// ── deactivateCore ──────────────────────────────────────────────────

test('deactivateCore revokes (as the owner) before it deletes, then switches off', async () => {
    const a = automation({ userId: 'owner', isActive: true });
    const { deps, calls } = harness(a);
    const r = await deactivateCore({ automation: a, actorId: 'editor', deps });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(calls.order, ['revoke:owner', 'delete', 'update']);
    assert.deepStrictEqual(calls.update[0], { updates: { isActive: false }, actor: 'editor' });
    assert.deepStrictEqual(calls.woke, ['deactivation']);
    assert.strictEqual(r.automation.isActive, false);
});

// ── convergeAfterPublish ────────────────────────────────────────────

const GMAIL = (label, filter = null) => ({ ...MANUAL, trigger: { id: 't1', kind: 'app_event', label, appEvent: { provider: 'gmail', event: 'mail.new', filter } } });
const EXTRA = (cron) => ({ ...MANUAL, triggers: [{ id: 't2', kind: 'schedule', schedule: { cron, tz: 'Europe/Amsterdam' } }] });

test('convergeAfterPublish re-registers triggers only when their fingerprint changed', async () => {
    const a = automation({ isActive: true });

    const same = harness(a);
    await convergeAfterPublish({ automation: a, definition: { ...EXTRA('0 9 * * *'), steps: [] }, previousLive: EXTRA('0 9 * * *'), isActive: true, deps: same.deps });
    assert.strictEqual(same.calls.schedules.length, 0, 'a step edit does not touch the schedules');
    assert.strictEqual(same.calls.subs.length, 0);

    const moved = harness(a);
    await convergeAfterPublish({ automation: a, definition: EXTRA('0 10 * * *'), previousLive: EXTRA('0 9 * * *'), isActive: true, deps: moved.deps });
    assert.strictEqual(moved.calls.schedules.length, 1);

    const relabel = harness(a);
    await convergeAfterPublish({ automation: a, definition: GMAIL('new label'), previousLive: GMAIL('old label'), isActive: true, deps: relabel.deps });
    assert.strictEqual(relabel.calls.subs.length, 0, 'a label edit does not re-anchor the poller cursor');

    const first = harness(a);
    await convergeAfterPublish({ automation: a, definition: GMAIL('x'), previousLive: null, isActive: true, ownerId: 'u1', deps: first.deps });
    assert.strictEqual(first.calls.subs.length, 1, 'a first publish registers');
    assert.strictEqual(first.calls.subs[0].ownerId, 'u1');

    const off = harness(a);
    await convergeAfterPublish({ automation: a, definition: EXTRA('0 10 * * *'), previousLive: null, isActive: false, deps: off.deps });
    assert.strictEqual(off.calls.schedules.length + off.calls.subs.length, 0, 'nothing is registered for an automation that is off');
});

test('convergeAfterPublish runs the form, answers, usage and KB-source syncs and wakes compliance', async () => {
    const a = automation({ isActive: true, organizationId: 'org-row', title: 'Intake' });
    const { deps, calls } = harness(a);
    const r = await convergeAfterPublish({ automation: a, definition: MANUAL, previousLive: MANUAL, isActive: true, organizationId: 'org-stage', reason: 'deployment', deps });
    assert.deepStrictEqual(r.warnings, []);
    assert.deepStrictEqual(r.answers, { datatableId: 'dt1' });
    assert.deepStrictEqual(calls.forms, ['a1']);
    assert.strictEqual(calls.answers.length, 1);
    assert.strictEqual(calls.usage.length, 1);
    assert.strictEqual(calls.usage[0].orgId, 'org-stage');
    assert.deepStrictEqual(calls.usage[0].opts.extraEntries, [{ datatableId: 'dt1', stepId: 'trigger:form', mode: 'write', columns: [] }],
        'the answers table rides along in the usage index');
    assert.deepStrictEqual(calls.kb, [{ id: 'a1', opts: { userId: 'u1', title: 'Intake' } }]);
    assert.deepStrictEqual(calls.woke, ['deployment']);
});

test('convergeAfterPublish with saveSyncs:false (the publish route) skips the save-time syncs', async () => {
    const a = automation({ isActive: true });
    const { deps, calls } = harness(a);
    await convergeAfterPublish({ automation: a, definition: MANUAL, previousLive: MANUAL, isActive: true, saveSyncs: false, deps });
    assert.strictEqual(calls.answers.length + calls.usage.length + calls.kb.length, 0);
    assert.deepStrictEqual(calls.forms, ['a1']);
    assert.deepStrictEqual(calls.woke, ['publish']);
});

test('convergeAfterPublish never throws: each failure is a warning and the rest still runs', async () => {
    const a = automation({ isActive: true });
    const { deps, calls } = harness(a);
    deps.syncSchedules = async () => { throw new Error('schedules down'); };
    deps.syncDatatableUsage = async () => { throw new Error('usage down'); };
    const r = await convergeAfterPublish({ automation: a, definition: EXTRA('0 10 * * *'), previousLive: null, isActive: true, deps });
    assert.deepStrictEqual(r.warnings.map(w => w.step), ['schedule re-sync', 'datatable usage']);
    assert.strictEqual(calls.kb.length, 1, 'the KB-source sync still ran');
    assert.deepStrictEqual(calls.woke, ['publish']);
});

test('convergeAfterPublish never throws when a fingerprint throws (a malformed definition)', async () => {
    const a = automation({ isActive: true });
    const { deps, calls } = harness(a);
    deps.fingerprints = {
        hasAppEventTrigger: () => { throw new Error('bad trigger'); },
        appEventFingerprint: () => 'x',
        scheduleFingerprint: () => { throw new Error('bad schedule'); },
    };
    const r = await convergeAfterPublish({ automation: a, definition: MANUAL, previousLive: MANUAL, isActive: true, deps });
    assert.deepStrictEqual(r.warnings.map(w => w.step), ['subscription re-sync', 'schedule re-sync']);
    assert.strictEqual(calls.subs.length + calls.schedules.length, 0);
    assert.deepStrictEqual(calls.forms, ['a1'], 'the rest still runs');
    assert.deepStrictEqual(calls.woke, ['publish']);
});

// ── checkBeforeLiveCore ─────────────────────────────────────────────

test('checkBeforeLiveCore: KB findings refuse with the route body; the owner and org are asked', async () => {
    const asked = [];
    const r = await checkBeforeLiveCore({
        automation: automation({ userId: 'owner' }), definition: MANUAL, ownerId: 'owner', organizationId: 'org-1',
        deps: {
            agentsFor: async (def, ownerId) => { asked.push(['agents', ownerId]); return null; },
            kbFindingsFor: async (def, opts) => { asked.push(['kb', opts]); return [{ code: 'kb.cross_org' }]; },
            permittedApps: async () => new Set(),
        },
    });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.body, { error: 'Invalid definition', details: [{ code: 'kb.cross_org' }] });
    assert.deepStrictEqual(asked, [['agents', 'owner'], ['kb', { orgId: 'org-1', userId: 'owner', stage: 'activate' }]]);
});

test('checkBeforeLiveCore without organizationId scopes the KB check to the automation\'s own organisation', async () => {
    const asked = [];
    const r = await checkBeforeLiveCore({
        automation: automation({ userId: 'owner', organizationId: 'org-row' }), definition: MANUAL, ownerId: 'owner',
        deps: {
            agentsFor: async () => null, permittedApps: async () => new Set(),
            // A same-org KB passes only when the org is known (automationKbCheck's sameOrg).
            kbFindingsFor: async (def, opts) => { asked.push(opts.orgId); return opts.orgId === 'org-row' ? [] : [{ code: 'kb.cross_org' }]; },
        },
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(asked, ['org-row']);
});

test('activateCore without organizationId passes the automation\'s organisation to the KB check', async () => {
    const a = automation({ organizationId: 'org-row' });
    const { deps, calls } = harness(a);
    const asked = [];
    deps.kbFindingsFor = async (def, opts) => { asked.push(opts.orgId); return opts.orgId === 'org-row' ? [] : [{ code: 'kb.cross_org' }]; };
    const r = await activateCore({ automation: a, actorId: 'u1', deps });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(asked, ['org-row']);
    assert.strictEqual(calls.publish.length, 1);
});

test('checkBeforeLiveCore: the presser\'s session stands in for the owner\'s only when they ARE the owner', async () => {
    const seen = [];
    const deps = { agentsFor: async () => null, kbFindingsFor: async () => [], permittedApps: async (opts) => { seen.push(opts); return new Set(); } };
    const session = { user: { id: 'owner' }, isAdmin: true };
    await checkBeforeLiveCore({ automation: automation({ userId: 'owner' }), definition: MANUAL, ownerId: 'owner', session, deps });
    await checkBeforeLiveCore({ automation: automation({ userId: 'owner' }), definition: MANUAL, ownerId: 'owner', session: { user: { id: 'editor' }, isAdmin: true }, deps });
    assert.deepStrictEqual(seen[0], { userId: 'owner', session, isAdmin: true });
    assert.deepStrictEqual(seen[1], { userId: 'owner', session: null, isAdmin: false });
});

test('checkBeforeLiveCore: the AI Act refusal comes back as `raise`, and refusalError makes it the HttpError', async () => {
    const r = await checkBeforeLiveCore({
        automation: automation(), definition: MANUAL, ownerId: 'u1',
        deps: {
            agentsFor: async () => null, kbFindingsFor: async () => [], permittedApps: async () => new Set(),
            aiActState: async () => ({ required: true, status: 'missing' }),
            aiActCheck: { gateRefusal: (s) => (s.status === 'missing' ? { status: 409, code: 'ai_act_check_required', message: 'Check first.', details: { aiAct: s } } : null) },
        },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.raise, true);
    const e = refusalError(r);
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, 'ai_act_check_required');
    assert.strictEqual(e.details.aiAct.status, 'missing');
});

test('checkBeforeLiveCore: a valid definition passes with its warnings', async () => {
    const r = await checkBeforeLiveCore({
        automation: automation(), definition: MANUAL, ownerId: 'u1',
        deps: { agentsFor: async () => null, kbFindingsFor: async () => [], permittedApps: async () => new Set() },
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.warnings));
});
