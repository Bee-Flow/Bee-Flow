/**
 * What the automation version routes accept, and what a restore keeps in step
 * (routes/automation/versions.js).
 *
 * A restore wrote `definition` and nothing else. The scheduler and the
 * activate route read the denormalised trigger columns, never the JSON, so a
 * restored version with a different trigger kept firing on the schedule of the
 * version it replaced — or never fired on the one it now showed — and an
 * active routine's subscription kept listening for the old event. What this
 * file pins:
 *
 *   - the trigger columns and next_run_at follow the restored definition;
 *   - an active routine's app-event subscription and extra schedules are
 *     re-synced when the restored trigger differs;
 *   - a stored cron that no longer parses refuses the restore, and nothing is written;
 *   - so does an approver who is no longer in the owner's organisation, as on
 *     every other save path — the restore used to write it, and the run then
 *     handed the approval to the owner without a word;
 *   - a query parameter or a body key is refused by name, not ignored;
 *   - a restored FORM gets what PUT gives it: its public pages, and an answers
 *     table that follows the form — re-linked when the restored form collects,
 *     and kept on the dependents index, which the restore used to wipe.
 *
 * Run: cd server && node --test routes/automation/versions.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store read and write lands in `touched`. A refused request must leave it empty.
const touched = [];
let AUTOMATION = null;
let VERSIONS = {};
// What the answers-table provisioning answers for the restored definition.
const fx = { answers: null };

const WEEKLY = { trigger: { kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } }, steps: [] };
const MANUAL = { trigger: { kind: 'manual' }, steps: [] };
const GMAIL = { trigger: { kind: 'app_event', provider: 'gmail', event: 'new_mail' }, steps: [] };
// A form that collects its answers, with a second form trigger beside it.
const FORM = {
    trigger: { kind: 'form', form: { title: 'Intake', collect: true, fields: [{ id: 'f1', type: 'email', label: 'E-mail' }] } },
    triggers: [{ id: 't2', kind: 'form', form: { title: 'Follow-up' } }],
    steps: [],
};
// A version whose approver has since left the owner's organisation.
const APPROVAL_ELSEWHERE = { trigger: { kind: 'manual' }, steps: [{ id: 's1', type: 'approval', approval: { assignee: { userId: 'x9' } } }] };

// By absolute path: Node caches a RELATIVE request per directory, and this
// file sits beside versions.js — the same '../../automation/scheduleSync'
// here would hand versions.js the real module past the resolve hook below.
const realScheduleSync = require(require('path').join(__dirname, '..', '..', 'automation', 'scheduleSync'));

const MOCKS = {
    '../../stores/automationStore': {
        getAutomation: async (id) => { touched.push({ what: 'getAutomation' }); return AUTOMATION && id === AUTOMATION.id ? { ...AUTOMATION } : null; },
        listVersions: async () => { touched.push({ what: 'listVersions' }); return []; },
        getVersion: async (id) => { touched.push({ what: 'getVersion' }); return VERSIONS[id] || null; },
        updateAutomation: async (id, updates) => {
            touched.push({ what: 'updateAutomation', args: [id, updates] });
            return { ...AUTOMATION, ...updates };
        },
        ensureFormPage: async (id, triggerStepId) => { touched.push({ what: 'ensureFormPage', args: [id, triggerStepId] }); },
    },
    '../../automation/validate': { validateDefinition: () => ({ ok: true, errors: [], warnings: [] }) },
    '../../automation/datatableUsageSync': {
        syncDatatableUsage: async (id, orgId, def, opts) => { touched.push({ what: 'syncDatatableUsage', args: [id, orgId, def, opts] }); },
    },
    '../../automation/formAnswers': {
        ensureAnswersTable: async (automation, def) => {
            touched.push({ what: 'ensureAnswersTable', args: [automation.id, def] });
            return fx.answers(automation, def);
        },
    },
    // The membership question is the database's; what the route does with
    // the answer is what is pinned here.
    '../../automation/approvalService': {
        validateApprovalAssignees: async (def, ownerId) => (def === APPROVAL_ELSEWHERE && ownerId === 'u1'
            ? [{ path: 'steps.s1.approval.assignee', message: 'Step s1: the chosen approver is not in your organisation.' }]
            : []),
    },
    '../../core/kb/kbSourceSync': { syncKbSources: async () => { touched.push({ what: 'syncKbSources' }); } },
    '../../automation/scheduleSync': {
        ...realScheduleSync,
        syncSchedules: async (id, def) => { touched.push({ what: 'syncSchedules', args: [id, def] }); return { synced: [], removed: true }; },
    },
    // The real module talks to the trigger bus; the route only needs its
    // three questions and the one call.
    '../../automation/subscriptionSync': {
        hasAppEventTrigger: (def) => def?.trigger?.kind === 'app_event',
        appEventFingerprint: (def) => JSON.stringify(def?.trigger?.kind === 'app_event' ? def.trigger : null),
        syncAppEventSubscription: async (id, userId, def) => { touched.push({ what: 'syncAppEventSubscription', args: [id, userId, def] }); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:automation-versions-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automation[\\/]versions\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./versions');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = Object.fromEntries(new URLSearchParams(search));
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const written = () => touched.find((t) => t.what === 'updateAutomation')?.args[1];
const called = (what) => touched.filter((t) => t.what === what);

test.beforeEach(() => {
    touched.length = 0;
    // The real module answers null, without a query, for a definition that is not a form.
    fx.answers = () => null;
    AUTOMATION = { id: 'a1', userId: 'u1', title: 'Weekly report', isActive: false, definition: MANUAL, triggerType: 'manual', scheduleCron: null };
    VERSIONS = {
        vWeekly: { id: 'vWeekly', automationId: 'a1', version: 2, definition: WEEKLY },
        vManual: { id: 'vManual', automationId: 'a1', version: 1, definition: MANUAL },
        vGmail: { id: 'vGmail', automationId: 'a1', version: 3, definition: GMAIL },
        vBroken: { id: 'vBroken', automationId: 'a1', version: 4, definition: { trigger: { kind: 'schedule', schedule: { cron: 'every monday' } }, steps: [] } },
        vForm: { id: 'vForm', automationId: 'a1', version: 6, definition: FORM },
        vApprover: { id: 'vApprover', automationId: 'a1', version: 7, definition: APPROVAL_ELSEWHERE },
    };
});

// ═══ What the routes accept ═════════════════════════════════════════

test('a query parameter on the history is refused by name, and nothing is read', async () => {
    const res = await dispatch({ method: 'GET', url: '/a1/versions?limit=5' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.match(res.body.error, /limit/);
    assert.deepStrictEqual(touched, []);
});

test('a restore takes no options: a body key is refused, and nothing is written', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vWeekly/restore', body: { keepTrigger: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(touched, []);
});

// ═══ A restore is a save: the trigger follows ═══════════════════════

test('restoring a weekly version onto a manual routine arms the weekly schedule', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vWeekly/restore', body: undefined });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const w = written();
    assert.strictEqual(w.triggerType, 'schedule');
    assert.strictEqual(w.scheduleCron, '0 9 * * 1');
    assert.strictEqual(w.scheduleTz, 'Europe/Amsterdam');
    assert.ok(w.nextRunAt && Date.parse(w.nextRunAt) > Date.now(), `next_run_at is computed, got ${w.nextRunAt}`);
    assert.strictEqual(res.body.restoredFromVersion, 2);
});

test('restoring a manual version onto a scheduled routine stops the schedule', async () => {
    AUTOMATION = { ...AUTOMATION, definition: WEEKLY, triggerType: 'schedule', scheduleCron: '0 9 * * 1', nextRunAt: '2026-09-28T07:00:00.000Z' };
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vManual/restore', body: {} });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const w = written();
    assert.strictEqual(w.triggerType, 'manual');
    assert.strictEqual(w.scheduleCron, null);
    assert.strictEqual(w.nextRunAt, null, 'the old slot is cleared, or the scheduler keeps claiming it');
});

test('a stored cron that no longer parses refuses the restore before anything is written', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vBroken/restore', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /^Stored version no longer validates/);
    assert.strictEqual(written(), undefined);
});

test('an approver who is no longer in the owner\'s organisation refuses the restore, as it refuses a save', async () => {
    // PUT has refused this since the check exists. The restore wrote it, and
    // at run time approvalLifecycle quietly handed the approval to the OWNER
    // instead — the person named in the step never heard of it.
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vApprover/restore', body: {} });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'Stored version no longer validates');
    assert.deepStrictEqual(res.body.details.map((d) => d.path), ['steps.s1.approval.assignee']);
    assert.strictEqual(written(), undefined, 'nothing is written');
});

test('an ACTIVE routine restored to a different app event re-subscribes', async () => {
    AUTOMATION = { ...AUTOMATION, isActive: true };
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vGmail/restore', body: {} });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(called('syncAppEventSubscription').map((c) => c.args.slice(0, 2)), [['a1', 'u1']]);
});

test('an ACTIVE routine restored to the same trigger keeps its subscription and slots', async () => {
    AUTOMATION = { ...AUTOMATION, isActive: true, definition: GMAIL };
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vGmail/restore', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(called('syncAppEventSubscription'), [], 'no poller cursor is re-anchored');
    assert.deepStrictEqual(called('syncSchedules'), []);
});

test('an ACTIVE routine restored to a version with extra schedules re-syncs them', async () => {
    AUTOMATION = { ...AUTOMATION, isActive: true };
    VERSIONS.vMulti = {
        id: 'vMulti', automationId: 'a1', version: 5,
        definition: { ...MANUAL, triggers: [{ id: 't2', kind: 'schedule', schedule: { cron: '0 17 * * 5' } }] },
    };
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vMulti/restore', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(called('syncSchedules').length, 1);
});

test('an INACTIVE routine is left for activation to arm', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vGmail/restore', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(called('syncAppEventSubscription'), []);
    assert.strictEqual(written().triggerType, 'app_event', 'but the columns activation reads are already right');
});

// ═══ A restore is a save: the form follows ══════════════════════════

const ANSWERS_ROW = { datatableId: 'dt_answers', stepId: 'trigger:form', mode: 'write', columns: [] };
const usageSynced = () => called('syncDatatableUsage')[0]?.args;

test('restoring a collecting form re-links its answers table, and the table stays on the "used by" list', async () => {
    // The table was unlinked when collection was switched off. Without this,
    // the restored form said it collected while every answer was dropped
    // (write.resolveAnswers skips an unlinked table, and says nothing).
    fx.answers = () => ({ table: { id: 'dt_answers' }, created: false, changed: true });
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vForm/restore', body: {} });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(called('ensureAnswersTable').map((c) => c.args), [['a1', FORM]], 'the table is measured against the RESTORED form');
    // The reconcile is delete-then-insert: a row left out here is a row erased.
    assert.deepStrictEqual(usageSynced()[3].extraEntries, [ANSWERS_ROW]);
    assert.deepStrictEqual(res.body.answers, { datatableId: 'dt_answers', created: false, changed: true });
});

test('every form trigger of the restored version gets its public page', async () => {
    fx.answers = () => ({ table: { id: 'dt_answers' }, created: false, changed: false });
    await dispatch({ method: 'POST', url: '/a1/versions/vForm/restore', body: {} });
    assert.deepStrictEqual(called('ensureFormPage').map((c) => c.args), [['a1', null], ['a1', 't2']],
        'the primary trigger is the NULL step id, the one loadForm reads');
});

test('an answers table that cannot be made does not fail the restore, and says why', async () => {
    fx.answers = () => ({ table: null, error: { code: 'quota_exceeded', message: 'This workspace has reached its table limit.' } });
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vForm/restore', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(written(), 'the definition was still restored');
    assert.strictEqual(res.body.answers.error.code, 'quota_exceeded');
    assert.deepStrictEqual(usageSynced()[3].extraEntries, []);
});

test('a provisioning failure nobody wrote for the caller is not echoed to them', async () => {
    fx.answers = () => { throw new Error('connection terminated unexpectedly (pg pool 3)'); };
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vForm/restore', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.answers.error.code, 'provision_failed');
    assert.doesNotMatch(JSON.stringify(res.body), /pg pool|terminated/);
});

test('a restore without a form provisions nothing and answers as before', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/versions/vWeekly/restore', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(called('ensureFormPage'), []);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['automation', 'restoredFromVersion']);
    assert.deepStrictEqual(usageSynced()[3].extraEntries, []);
});
