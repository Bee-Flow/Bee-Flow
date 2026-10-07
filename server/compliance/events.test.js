/**
 * Compliance event bus — producer/consumer contract. The three previously
 * orphaned events (DLP_CONFIG_CHANGED, AGENT_PUBLISHED,
 * EXTERNAL_TRANSFER_DETECTED) now have real producers, so these tests pin the
 * listener side: each event re-runs the right check with runType 'event'.
 *
 * Fakes for runner/notificationStore/db are injected into require.cache so no
 * Postgres (and no real check evaluation) is involved.
 *
 * Run: node --test server/compliance/events.test.js
 */

const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const runnerCalls = [];
const notifications = [];

function inject(relPath, exports) {
    const resolved = require.resolve(path.join(__dirname, relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const frameworkRuns = [];
const invalidated = [];

inject('./runner.js', {
    runOne: async (orgId, checkId, opts) => {
        runnerCalls.push({ orgId, checkId, opts });
        if (checkId === 'DISABLED-check') { const e = new Error('disabled'); e.status = 409; throw e; }
    },
    runAll: async () => [],
    runFramework: async (orgId, frameworkId, opts) => { frameworkRuns.push({ orgId, frameworkId, opts }); },
});
let craPrimary = [{ id: 'CRA-Art14-vuln-reporting-clocks' }, { id: 'CRA-AnnexI-II1-sbom' }];
inject('./registry.js', {
    getPrimary: (code) => (code === 'CRA' ? craPrimary : []),
    get: () => null,
    getAll: () => [],
});
inject('./countsCache.js', {
    invalidate: (orgId) => { invalidated.push(orgId); },
});
inject('../stores/notificationStore.js', {
    createNotification: async (n) => { notifications.push(n); },
});
// The notice dedupe claim (compliance_notify_log). A set per test run: the
// first claim of a (key, window) wins, a repeat is refused.
const claims = new Set();
inject('../stores/complianceStore.js', {
    markNotified: async (org, kind, id, offset) => {
        const k = [org, kind, id, offset].join('|');
        if (claims.has(k)) return false;
        claims.add(k);
        return true;
    },
});
// The transfer-signal producer now double-checks a cross-replica DB claim
// (compliance_signal_debounce): a returned row means "we won the claim, emit";
// null means another replica already emitted. Default: we win.
let claimResponse = () => ({ claimed: 1 });
inject('../db.js', {
    exec: async () => {},
    run: async () => ({ rowCount: 0, rows: [] }),
    getOne: async (sql) => (/compliance_signal_debounce/.test(String(sql)) ? claimResponse() : null),
    getAll: async () => [{ id: 'admin-1' }],
});

const events = require('./events');

const settle = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

beforeEach(() => {
    runnerCalls.length = 0;
    notifications.length = 0;
    frameworkRuns.length = 0;
    invalidated.length = 0;
    claims.clear();
});

// ─────────────── New events (Compliance Center redesign) ───────────────

test('EVENTS names match frameworkPolicy.POLICY_EVENTS (the policy emits by string)', () => {
    assert.strictEqual(events.EVENTS.FRAMEWORK_ENABLED, 'framework_enabled');
    assert.strictEqual(events.EVENTS.FRAMEWORK_DISABLED, 'framework_disabled');
    assert.strictEqual(events.EVENTS.FRAMEWORK_RELEVANCE_CHANGED, 'framework_relevance_changed');
    for (const k of ['AI_ACT_ATTESTED', 'CONTENT_MARKING_CHANGED', 'DSR_EXTENDED', 'DSR_FULFILLED', 'CRA_VULNERABILITY_REPORTED']) {
        assert.strictEqual(typeof events.EVENTS[k], 'string', k);
    }
    // legacy names still there
    assert.strictEqual(events.EVENTS.DLP_CONFIG_CHANGED, 'dlp_config_changed');
});

test('FRAMEWORK_ENABLED notifies admins + invalidates counts; does NOT run the sweep unless asked (the route awaits it)', async () => {
    events.emit(events.EVENTS.FRAMEWORK_ENABLED, { orgId: 'org1', frameworkId: 'nis2', actorId: 'u1' });
    await settle();
    assert.strictEqual(frameworkRuns.length, 0);
    assert.deepStrictEqual(invalidated, ['org1']);
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].category, 'heads_up');
    assert.match(notifications[0].link, /compliance\/frameworks/);
});

test('FRAMEWORK_ENABLED with run:true runs the framework sweep as an event run', async () => {
    events.emit(events.EVENTS.FRAMEWORK_ENABLED, { orgId: 'org1', frameworkId: 'cra', run: true });
    await settle();
    assert.deepStrictEqual(frameworkRuns, [{ orgId: 'org1', frameworkId: 'cra', opts: { runType: 'event' } }]);
});

test('FRAMEWORK_DISABLED / RELEVANCE_CHANGED only drop the counts cache', async () => {
    events.emit(events.EVENTS.FRAMEWORK_DISABLED, { orgId: 'org2', frameworkId: 'nis2' });
    events.emit(events.EVENTS.FRAMEWORK_RELEVANCE_CHANGED, { orgId: 'org3', frameworkId: 'dora' });
    await settle();
    assert.deepStrictEqual(invalidated.sort(), ['org2', 'org3']);
    assert.strictEqual(runnerCalls.length, 0);
    assert.strictEqual(notifications.length, 0);
});

test('AI_ACT_ATTESTED re-runs Art-53 and, for an automation, the per-subject Art-50 marking check', async () => {
    events.emit(events.EVENTS.AI_ACT_ATTESTED, { orgId: 'org1', targetKind: 'automation', targetId: 'auto-7', outcome: 'transparency' });
    await settle();
    assert.deepStrictEqual(runnerCalls.map(c => c.checkId), ['AIA-Art53-model-inventory', 'AIA-Art50-content-marking']);
    assert.strictEqual(runnerCalls[1].opts.subjectId, 'auto-7');
    runnerCalls.length = 0;
    events.emit(events.EVENTS.AI_ACT_ATTESTED, { orgId: 'org1', targetKind: 'agent', targetId: 'ag-1' });
    await settle();
    assert.deepStrictEqual(runnerCalls.map(c => c.checkId), ['AIA-Art53-model-inventory']);
});

test('CONTENT_MARKING_CHANGED re-runs the Art-50 marking check and invalidates counts', async () => {
    events.emit(events.EVENTS.CONTENT_MARKING_CHANGED, { orgId: 'org1', enabled: true });
    await settle();
    assert.deepStrictEqual(runnerCalls, [{ orgId: 'org1', checkId: 'AIA-Art50-content-marking', opts: { runType: 'event' } }]);
    assert.deepStrictEqual(invalidated, ['org1']);
});

test('DSR_EXTENDED / DSR_FULFILLED route deletion to Art-17 and the rest to Art-15 — payload carries no e-mail', async () => {
    events.emit(events.EVENTS.DSR_EXTENDED, { orgId: 'org1', requestId: 12, requestType: 'deletion' });
    events.emit(events.EVENTS.DSR_FULFILLED, { orgId: 'org1', requestId: 13, requestType: 'access' });
    await settle();
    assert.deepStrictEqual(runnerCalls.map(c => c.checkId).sort(), ['GDPR-Art15-dsr-access', 'GDPR-Art17-dsr-deletion']);
});

test('CRA_VULNERABILITY_REPORTED re-runs every primary CRA check', async () => {
    events.emit(events.EVENTS.CRA_VULNERABILITY_REPORTED, { orgId: 'org1', incidentId: 5, stage: 'early_warning' });
    await settle();
    assert.deepStrictEqual(runnerCalls.map(c => c.checkId), ['CRA-Art14-vuln-reporting-clocks', 'CRA-AnnexI-II1-sbom']);
});

test('a 409 framework_disabled from the runner is swallowed silently by the rerun helper', async () => {
    // The CONTENT_MARKING handler uses _rerun; drive it through a check id the fake runner refuses.
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    craPrimary = [{ id: 'DISABLED-check' }];
    try {
        events.emit(events.EVENTS.CRA_VULNERABILITY_REPORTED, { orgId: 'orgD' });
        await settle();
    } finally {
        console.warn = orig;
        craPrimary = [{ id: 'CRA-Art14-vuln-reporting-clocks' }, { id: 'CRA-AnnexI-II1-sbom' }];
    }
    assert.strictEqual(runnerCalls.length, 1, 'the runner was asked');
    assert.strictEqual(warns.filter(w => /DISABLED-check/.test(w)).length, 0, 'a 409 is not a warning');
    assert.deepStrictEqual(invalidated, ['orgD'], 'counts still invalidated');
});

test('DLP_CONFIG_CHANGED re-runs the Art-32 DLP check as an event run', async () => {
    events.emit(events.EVENTS.DLP_CONFIG_CHANGED, { orgId: 'org1' });
    await settle();
    assert.deepStrictEqual(runnerCalls, [
        { orgId: 'org1', checkId: 'GDPR-Art32-dlp-enabled', opts: { runType: 'event' } },
    ]);
});

test('AGENT_PUBLISHED re-runs Art-50 and the per-agent Art-35', async () => {
    events.emit(events.EVENTS.AGENT_PUBLISHED, { orgId: 'org1', agentId: 'a9' });
    await settle();
    assert.strictEqual(runnerCalls.length, 2);
    assert.strictEqual(runnerCalls[0].checkId, 'AIA-Art50-ai-disclosure');
    assert.strictEqual(runnerCalls[1].checkId, 'GDPR-Art35-dpia-high-risk');
    assert.strictEqual(runnerCalls[1].opts.subjectId, 'a9');
});

test('EXTERNAL_TRANSFER_DETECTED re-runs Art-44 and notifies org admins', async () => {
    events.emit(events.EVENTS.EXTERNAL_TRANSFER_DETECTED, { orgId: 'org1', operator: 'openai', country_code: 'US' });
    await settle();
    assert.strictEqual(runnerCalls[0].checkId, 'GDPR-Art44-external-transfers');
    assert.strictEqual(notifications.length, 1);
    assert.match(notifications[0].message, /openai/);
});

test('DSR_SUBMITTED routes deletion to Art-17 and everything else to Art-15', async () => {
    events.emit(events.EVENTS.DSR_SUBMITTED, { orgId: 'org1', requestType: 'deletion' });
    await settle();
    assert.strictEqual(runnerCalls[0].checkId, 'GDPR-Art17-dsr-deletion');
    events.emit(events.EVENTS.DSR_SUBMITTED, { orgId: 'org1', requestType: 'access' });
    await settle();
    assert.strictEqual(runnerCalls[1].checkId, 'GDPR-Art15-dsr-access');
});

test('events without an orgId are ignored', async () => {
    events.emit(events.EVENTS.DLP_CONFIG_CHANGED, {});
    events.emit(events.EVENTS.AGENT_PUBLISHED, {});
    await settle();
    assert.strictEqual(runnerCalls.length, 0);
});

test('external-transfer debounce collapses repeats per org+operator', async () => {
    // The producer lives in integrationActivityStore; its fake-db require is
    // already satisfied by the injection above.
    const store = require('../stores/integrationActivityStore');
    store._signalExternalTransfer({ orgId: 'orgX', operator: 'openai', countryCode: 'US' });
    store._signalExternalTransfer({ orgId: 'orgX', operator: 'openai', countryCode: 'US' });
    store._signalExternalTransfer({ orgId: 'orgX', operator: 'microsoft', countryCode: 'US' });
    await settle();
    const art44Runs = runnerCalls.filter(c => c.checkId === 'GDPR-Art44-external-transfers');
    assert.strictEqual(art44Runs.length, 2, 'same operator twice must emit once; a new operator emits again');
});

test('a lost cross-replica claim suppresses the emit (another pod was first)', async () => {
    const store = require('../stores/integrationActivityStore');
    claimResponse = () => null; // another replica claimed within 24 h
    store._signalExternalTransfer({ orgId: 'orgZ', operator: 'aws', countryCode: 'US' });
    await settle();
    assert.strictEqual(
        runnerCalls.filter(c => c.checkId === 'GDPR-Art44-external-transfers').length, 0,
        'the in-process map allowed it, but the DB claim must win',
    );
    claimResponse = () => ({ claimed: 1 });
});

test('a FAILING claim query fails open — the signal still emits', async () => {
    const store = require('../stores/integrationActivityStore');
    claimResponse = () => { throw new Error('db down'); };
    store._signalExternalTransfer({ orgId: 'orgW', operator: 'hetzner', countryCode: 'DE' });
    await settle();
    assert.strictEqual(
        runnerCalls.filter(c => c.checkId === 'GDPR-Art44-external-transfers').length, 1,
        'one extra notification beats silently dropping an Art-44 signal',
    );
    claimResponse = () => ({ claimed: 1 });
});

// ─────────────── Notices: who and how often ───────────────

test('the same framework enabled twice in a day is one notice', async () => {
    events.emit(events.EVENTS.FRAMEWORK_ENABLED, { orgId: 'org1', frameworkId: 'nis2' });
    await settle();
    events.emit(events.EVENTS.FRAMEWORK_ENABLED, { orgId: 'org1', frameworkId: 'nis2' });
    await settle();
    assert.strictEqual(notifications.length, 1);
    events.emit(events.EVENTS.FRAMEWORK_ENABLED, { orgId: 'org1', frameworkId: 'dora' });
    await settle();
    assert.strictEqual(notifications.length, 2, 'another framework is another notice');
});

test('a burst of DSR submissions of one type is one notice per hour; another type still notifies', async () => {
    for (let i = 0; i < 3; i++) events.emit(events.EVENTS.DSR_SUBMITTED, { orgId: 'org1', requestType: 'access' });
    await settle();
    assert.strictEqual(notifications.length, 1);
    events.emit(events.EVENTS.DSR_SUBMITTED, { orgId: 'org1', requestType: 'deletion' });
    await settle();
    assert.strictEqual(notifications.length, 2);
    assert.strictEqual(runnerCalls.length, 4, 'every submission still re-runs its check');
});

test('the recipient query includes the DPO', () => {
    const { RECIPIENT_SQL } = require('./adminNotices');
    assert.match(RECIPIENT_SQL, /'org_admin', 'admin', 'dpo'/);
});

// ─────────────── Projects ───────────────

test('PROJECT_CHANGED queues a debounced review of that project and one run of the workspace-wide checks per burst', async () => {
    const subjectReview = require('./subjectReview');
    subjectReview._reset();
    events._resetProjectReruns();
    events.emit(events.EVENTS.PROJECT_CHANGED, { orgId: 'org1', projectId: 'p1', reason: 'members' });
    events.emit(events.EVENTS.PROJECT_CHANGED, { orgId: 'org1', projectId: 'p1', reason: 'members' });
    events.emit(events.EVENTS.PROJECT_CHANGED, { orgId: 'org1', projectId: 'p2', reason: 'files' });
    await settle();
    assert.strictEqual(subjectReview._armedCount(), 2, 'one review per project, coalesced');
    assert.strictEqual(events._projectRerunCount(), 3, 'members → access + orphaned content, files → unscanned files, once each');
    assert.strictEqual(runnerCalls.length, 0, 'nothing runs on the emitter\'s turn');
    events.emit(events.EVENTS.PROJECT_CHANGED, { orgId: '', projectId: 'p3', reason: 'members' });
    await settle();
    assert.strictEqual(subjectReview._armedCount(), 2, 'no org, nothing to judge');
    subjectReview._reset();
    events._resetProjectReruns();
});

test('an AI-mode switch re-runs the AI-joins-by-itself check whole, once per burst — a project review never finds its chats', async () => {
    const subjectReview = require('./subjectReview');
    subjectReview._reset();
    events._resetProjectReruns();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        for (const projectId of ['p1', 'p1', 'p2']) events.emit(events.EVENTS.PROJECT_CHANGED, { orgId: 'org1', projectId, reason: 'ai_mode' });
        await settle();
        assert.strictEqual(events._projectRerunCount(), 1, 'three switches in two projects are one run for the org');
        assert.strictEqual(runnerCalls.length, 0, 'nothing runs on the emitter\'s turn');
        mock.timers.tick(Number(process.env.COMPLIANCE_PROJECT_RERUN_DEBOUNCE_MS || 30000));
        await settle();
        assert.deepStrictEqual(runnerCalls.map(c => [c.orgId, c.checkId, c.opts.subjectId]),
            [['org1', 'GDPR-Art35-project-ai-participation', undefined]],
            'a whole run (no subject), which is what retires the chat that just left the population');
        assert.strictEqual(runnerCalls[0].opts.runType, 'event');
    } finally {
        mock.timers.reset();
        subjectReview._reset();
        events._resetProjectReruns();
    }
});

test('CHAT_MONITORING_CHANGED re-runs both chat signals checks and drops the counts cache', async () => {
    assert.deepStrictEqual([...events.CHAT_SIGNAL_CHECKS], ['GDPR-Art32-chat-shield-coverage', 'GDPR-Art35-chat-monitoring-safeguards']);
    assert.ok(Object.isFrozen(events.CHAT_SIGNAL_CHECKS));
    assert.strictEqual(events.EVENTS.CHAT_MONITORING_CHANGED, 'chat_monitoring_changed');
    assert.strictEqual(Object.keys(events.EVENTS).pop(), 'CHAT_MONITORING_CHANGED', 'appended as the last event');

    events.emit(events.EVENTS.CHAT_MONITORING_CHANGED, { orgId: 'org1' });
    await settle();
    await settle();
    assert.deepStrictEqual(runnerCalls.map(c => [c.orgId, c.checkId, c.opts.runType]), [
        ['org1', 'GDPR-Art32-chat-shield-coverage', 'event'],
        ['org1', 'GDPR-Art35-chat-monitoring-safeguards', 'event'],
    ]);
    assert.deepStrictEqual(invalidated, ['org1']);
    assert.strictEqual(notifications.length, 0, 'no notice: the admin made the change');

    runnerCalls.length = 0;
    events.emit(events.EVENTS.CHAT_MONITORING_CHANGED, {});
    await settle();
    assert.strictEqual(runnerCalls.length, 0, 'no org, nothing to re-run');
});
