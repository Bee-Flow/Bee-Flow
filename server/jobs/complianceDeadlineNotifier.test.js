'use strict';

/**
 * The statutory clocks nudge admins exactly once per tier (compliance_notify_log),
 * overdue re-fires daily, and no message ever carries a subject's address.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// The job requires ../db and ../telemetry/metrics at load time — stub both so
// no pool is opened.
const DB = require.resolve('../db.js');
const METRICS = require.resolve('../telemetry/metrics.js');
const APP_PATHS = require.resolve('../utils/appPaths.js');
const originalResolve = Module._resolveFilename;
const jobRuns = [];
require.cache[DB] = { id: DB, filename: DB, loaded: true, exports: { getAll: async () => [] } };
require.cache[METRICS] = { id: METRICS, filename: METRICS, loaded: true, exports: { recordJobRun: (r) => jobRuns.push(r) } };
// appPaths is real (pure string builders) — but make sure it is loadable without side effects.
require(APP_PATHS);

const notifier = require('./complianceDeadlineNotifier');

test.after(() => {
    Module._resolveFilename = originalResolve;
    delete require.cache[DB];
    delete require.cache[METRICS];
});

const NOW = Date.parse('2026-09-14T12:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const at = (ms) => new Date(NOW + ms).toISOString();

function harness(over = {}) {
    const sent = [];
    const log = new Set();
    const deps = {
        now: () => NOW,
        // The job always sweeps 'default' too; the fake stores below ignore the
        // org, so only org_a has an admin to notify — 'default' stays silent.
        getAll: async (sql, params) => {
            if (/FROM users/.test(sql)) return params[0] === 'org_a' ? [{ id: `admin_of_${params[0]}` }] : [];
            return [];
        },
        userStore: { getAllOrganizations: async () => [{ id: 'org_a' }] },
        notificationStore: { createNotification: async (n) => { sent.push(n); } },
        complianceStore: {
            markNotified: async (orgId, kind, id, key) => {
                const k = `${orgId}|${kind}|${id}|${key}`;
                if (log.has(k)) return false;
                log.add(k);
                return true;
            },
        },
        incidentStore: { listNeedingAttention: async () => [], listOpenClocks: async () => [] },
        dsrStore: { listOpenWithDeadlines: async () => [] },
        obligationStore: null,
        aiActAssessmentStore: { listExpiring: async () => [] },
        frameworkPolicy: null,
        calendar: null,
        frameworks: { MILESTONES: [] },
        ...over,
    };
    return { deps, sent, log };
}

const run = (deps) => notifier.runOnce({ deps });

test('DSR tiers on due_at: 5 d and 1 d fire once each, overdue fires daily, messages carry "#id · type" and no address', async () => {
    const rows = [
        { id: 1, request_type: 'access', status: 'pending', due_at: at(4 * DAY), subject_email: 'leak@example.org' },
        { id: 2, request_type: 'deletion', status: 'in_progress', due_at: at(20 * HOUR), extended_until: at(20 * HOUR) },
        { id: 3, request_type: 'access', status: 'pending', due_at: at(-2 * DAY) },
        { id: 4, request_type: 'access', status: 'pending', due_at: at(20 * DAY) },
    ];
    const { deps, sent } = harness({ dsrStore: { listOpenWithDeadlines: async () => rows } });

    await run(deps);
    const dsr = sent.filter(n => /Data-subject request/.test(n.title));
    assert.strictEqual(dsr.length, 3, 'one nudge each for #1 (5 d), #2 (1 d), #3 (overdue); #4 is quiet');
    assert.ok(dsr.some(n => n.title === 'Data-subject request due within 5 days' && n.message.includes('#1 · access')));
    assert.ok(dsr.some(n => n.title === 'Data-subject request due tomorrow' && n.message.includes('#2 · deletion') && n.message.includes('already extended')));
    assert.ok(dsr.some(n => n.title === 'Data-subject request overdue' && n.message.includes('#3 · access')));
    for (const n of dsr) {
        assert.ok(!JSON.stringify(n).includes('@'), 'no address in any notification');
        assert.match(n.link, /^\/app\/admin\/compliance\/dsr\?id=\d+$/);
        assert.strictEqual(n.userId, 'admin_of_org_a');
        assert.strictEqual(n.category, 'urgent');
    }

    // Same day again: nothing new — every tier is logged.
    await run(deps);
    assert.strictEqual(sent.filter(n => /Data-subject request/.test(n.title)).length, 3);

    // Next day: #3 re-fires as overdue (new day key) and #2 has meanwhile passed
    // its deadline → overdue too; #1 stays on the 5 d tier already sent.
    deps.now = () => NOW + DAY;
    await run(deps);
    const again = sent.filter(n => /Data-subject request/.test(n.title)).slice(3);
    assert.deepStrictEqual(again.map(n => n.title), ['Data-subject request overdue', 'Data-subject request overdue']);
    assert.deepStrictEqual(again.map(n => n.message.match(/#\d/)[0]).sort(), ['#2', '#3']);

    // Three more days: #1 crosses into the 1 d tier — a different key, so it fires.
    deps.now = () => NOW + 3 * DAY + 6 * HOUR;
    await run(deps);
    const titles = sent.filter(n => n.message.includes('#1 · access')).map(n => n.title);
    assert.deepStrictEqual(titles, ['Data-subject request due within 5 days', 'Data-subject request due tomorrow']);
});

test('CRA clocks: early warning within 6 h / overdue, full report within 24 h / overdue; stamped ones skipped; non-CRA ignored', async () => {
    const clocks = [
        // early warning due in 3 h, full report due in 51 h → early only
        { id: 10, kind: 'vulnerability', regimes: ['CRA'], early_warning_due_at: at(3 * HOUR), final_report_due_at: at(51 * HOUR) },
        // early warning stamped, full report due in 10 h → full only
        { id: 11, kind: 'vulnerability', regimes: '["CRA"]', early_warning_due_at: at(-20 * HOUR), early_warning_sent_at: at(-21 * HOUR), final_report_due_at: at(10 * HOUR) },
        // both overdue and unstamped → both, and they re-fire daily
        { id: 12, kind: 'security_incident', regimes: ['NIS2', 'CRA'], early_warning_due_at: at(-30 * HOUR), final_report_due_at: at(-1 * HOUR) },
        // GDPR breach: not a CRA clock
        { id: 13, kind: 'breach', regimes: ['GDPR'], early_warning_due_at: at(-1 * HOUR), final_report_due_at: at(-1 * HOUR) },
        // early warning due in 12 h → outside the 6 h window
        { id: 14, kind: 'vulnerability', regimes: ['CRA'], early_warning_due_at: at(12 * HOUR), final_report_due_at: at(60 * HOUR) },
    ];
    const { deps, sent } = harness({ incidentStore: { listNeedingAttention: async () => [], listOpenClocks: async () => clocks } });
    await run(deps);
    const cra = sent.filter(n => /^CRA /.test(n.title));
    const byIncident = (id) => cra.filter(n => n.message.includes(`#${id} `)).map(n => n.title);
    assert.deepStrictEqual(byIncident(10), ['CRA early warning (24 h) due soon']);
    assert.deepStrictEqual(byIncident(11), ['CRA final report due soon']);
    assert.deepStrictEqual(byIncident(12), ['CRA early warning (24 h) overdue', 'CRA final report overdue']);
    assert.deepStrictEqual(byIncident(13), []);
    assert.deepStrictEqual(byIncident(14), []);
    for (const n of cra) assert.match(n.link, /^\/app\/admin\/compliance\/incidents\/\d+$/);

    await run(deps);
    assert.strictEqual(sent.filter(n => /^CRA /.test(n.title)).length, cra.length, 'no duplicates on the same day');
    deps.now = () => NOW + DAY;
    await run(deps);
    // Next day: #12's two overdue clocks re-fire (new day key); #10's early
    // warning, #11's full report and #14's early warning have meanwhile passed
    // their due time → three fresh overdue nudges. Nothing "due soon" repeats.
    const day2 = sent.filter(n => /^CRA /.test(n.title)).slice(cra.length);
    assert.strictEqual(day2.length, 5);
    assert.ok(day2.every(n => /overdue$/.test(n.title)));
    assert.deepStrictEqual(day2.filter(n => n.message.includes('#14 ')).map(n => n.title), ['CRA early warning (24 h) overdue']);
});

test('calendar milestones of relevant frameworks fire at 30 / 7 / 0 days, once per tier', async () => {
    const MILESTONES = [
        { id: 'cra_full', date: '2026-10-09', framework_id: 'cra', kind: 'phase' },          // 25 d → 30 tier
        { id: 'pld_in_force', date: '2026-09-19', framework_id: 'pld', kind: 'in_force' },   // 5 d → 7 tier
        { id: 'nis2_x', date: '2026-09-14', framework_id: 'nis2', kind: 'phase' },           // today → 0 tier
        { id: 'dora_in_force', date: '2026-09-20', framework_id: 'dora', kind: 'in_force' },// not relevant
        { id: 'aia_far', date: '2027-12-02', framework_id: 'aia', kind: 'phase' },           // > 30 d
        { id: 'past', date: '2026-09-01', framework_id: 'cra', kind: 'phase' },              // gone
        { id: 'uncertain', date: null, framework_id: 'gdpr', kind: 'uncertain' },
    ];
    const frameworkPolicy = {
        resolve: async () => [
            { id: 'cra', enabled: true, relevance: 'relevant' },
            { id: 'pld', enabled: true, relevance: 'unknown' },
            { id: 'nis2', enabled: true, relevance: 'relevant' },
            { id: 'dora', enabled: true, relevance: 'not_relevant' },
            { id: 'aia', enabled: true, relevance: 'relevant' },
        ],
    };
    const { deps, sent } = harness({ frameworks: { MILESTONES }, frameworkPolicy });
    await run(deps);
    const cal = sent.filter(n => /regulatory milestone/.test(n.title));
    assert.deepStrictEqual(cal.map(n => n.title).sort(), [
        'CRA: regulatory milestone in 25 day(s)',
        'NIS2: regulatory milestone today',
        'PLD: regulatory milestone in 5 day(s)',
    ]);
    for (const n of cal) assert.strictEqual(n.link, '/app/admin/compliance/frameworks?tab=calendar');

    await run(deps);
    assert.strictEqual(sent.filter(n => /regulatory milestone/.test(n.title)).length, 3);

    // 20 days later cra_full is 5 days out → the 7 tier fires (a new key); pld is past.
    deps.now = () => NOW + 20 * DAY;
    await run(deps);
    const craTitles = sent.filter(n => /^CRA: regulatory/.test(n.title)).map(n => n.title);
    assert.deepStrictEqual(craTitles, ['CRA: regulatory milestone in 25 day(s)', 'CRA: regulatory milestone in 5 day(s)']);
});

test('the calendar comes from compliance/calendar.list(orgId, { all: true }) — its relevance flag wins, its affects counts ride along, the raw frameworks table is not used', async () => {
    const calls = [];
    const calendar = {
        list: async (orgId, opts) => {
            calls.push([orgId, opts]);
            return [
                { id: 'cra_full', date: '2026-09-21', framework_id: 'cra', kind: 'phase', relevant: true,
                  affects: { automations: 3, agents: 1, webpages: null, forms: 0 } },
                // The org marked EAA not relevant — calendar.list says so, and the notifier must obey.
                { id: 'eaa_x', date: '2026-09-21', framework_id: 'eaa', kind: 'phase', relevant: false, affects: null },
                // A custom framework's milestone without an id: still nudged, on a stable key.
                { id: null, label_key: 'compliance.cal_ms_custom_x_label', date: '2026-09-16', framework_id: 'custom_1', kind: 'in_force', relevant: true },
            ];
        },
    };
    const { deps, sent, log } = harness({
        calendar,
        frameworks: { MILESTONES: [{ id: 'should_not_be_used', date: '2026-09-15', framework_id: 'x', kind: 'phase' }] },
    });
    await run(deps);

    assert.deepStrictEqual(calls.map(([orgId, opts]) => [orgId, opts?.all]).sort(),
        [['default', true], ['org_a', true]], 'the real API, called per org with the full list');

    const cal = sent.filter(n => /egulatory milestone/.test(n.title));
    assert.deepStrictEqual(cal.map(n => n.title).sort(), [
        'CRA: regulatory milestone in 7 day(s)',
        'CUSTOM_1: regulatory milestone in 2 day(s)',
    ], 'the not-relevant framework is silent, the fallback table is never read');
    assert.ok(!JSON.stringify(sent).includes('should_not_be_used'), 'frameworks.MILESTONES must not be consulted when the calendar answers');

    const cra = cal.find(n => /^CRA/.test(n.title));
    assert.ok(cra.message.includes('Affects you: 3 automations · 1 agent.'), cra.message);
    assert.ok(!/webpage|public form/.test(cra.message), 'an unknown (null) or zero count stays out');
    for (const n of cal) assert.strictEqual(n.link, '/app/admin/compliance/frameworks?tab=calendar');

    // The id-less milestone claims a stable key, so a second sweep is silent.
    assert.ok([...log].some(k => k.includes('compliance.cal_ms_custom_x_label')), [...log].join('\n'));
    await run(deps);
    assert.strictEqual(sent.filter(n => /egulatory milestone/.test(n.title)).length, cal.length);
});

test('a milestone the notifier cannot render is skipped without burning its notify-log slot, and the rest of the calendar still fires', async () => {
    // A future calendar source with an exotic row: reading `kind` blows up.
    const exotic = { id: 'exotic_milestone', date: '2026-09-21', framework_id: 'cra', relevant: true,
        get kind() { throw new Error('exotic source'); } };
    const calendar = { list: async () => [exotic, { id: 'pld_in_force', date: '2026-09-19', framework_id: 'pld', kind: 'in_force', relevant: true }] };
    const { deps, sent, log } = harness({ calendar });

    await run(deps);   // must not throw
    assert.deepStrictEqual(sent.filter(n => /egulatory milestone/.test(n.title)).map(n => n.title),
        ['PLD: regulatory milestone in 5 day(s)'], 'the milestone behind the broken one still gets its nudge');
    assert.ok(![...log].some(k => k.includes('exotic_milestone')),
        'a claim that produced no notification must stay free for the retry');

    // Source fixed → the nudge still goes out, because the slot was never burned.
    Object.defineProperty(exotic, 'kind', { value: 'phase', configurable: true });
    await run(deps);
    assert.deepStrictEqual(sent.filter(n => n.message.includes('exotic milestone')).map(n => n.title),
        ['CRA: regulatory milestone in 7 day(s)']);
});

test('one org failing does not cost the orgs behind it their sweep — the run is still recorded as an error', async () => {
    // A poisoned attestation row for the 'default' org, which is swept first.
    const poisoned = { expires_at: at(10 * DAY), target_id: 'auto_1', get target_kind() { throw new Error('poison row'); } };
    const { deps, sent } = harness({
        aiActAssessmentStore: { listExpiring: async (orgId) => (orgId === 'default' ? [poisoned] : []) },
        dsrStore: { listOpenWithDeadlines: async () => [{ id: 1, request_type: 'access', status: 'pending', due_at: at(20 * HOUR) }] },
    });
    jobRuns.length = 0;
    await run(deps);   // must not throw
    assert.deepStrictEqual(sent.filter(n => /Data-subject request/.test(n.title)).map(n => n.title),
        ['Data-subject request due tomorrow'], 'org_a is swept even though the org before it threw');
    assert.strictEqual(jobRuns.at(-1).status, 'error', 'the failed section stays visible in the job metric');
});

test('AI Act attestation expiries within 30 days fire once; expired ones daily', async () => {
    const rows = [
        { target_kind: 'automation', target_id: 'auto_1', expires_at: at(10 * DAY), outcome: 'transparency' },
        { target_kind: 'agent', target_id: 'agent_9', expires_at: at(-1 * DAY), outcome: 'minimal' },
    ];
    const { deps, sent } = harness({ aiActAssessmentStore: { listExpiring: async (orgId, days) => { assert.strictEqual(days, 30); return rows; } } });
    await run(deps);
    const att = sent.filter(n => /AI Act self-assessment/.test(n.title));
    assert.strictEqual(att.length, 2);
    assert.ok(att.some(n => n.title === 'AI Act self-assessment expires within 30 days' && n.message.includes('automation auto_1')));
    assert.ok(att.some(n => n.title === 'AI Act self-assessment expired' && n.message.includes('agent agent_9')));
    for (const n of att) assert.strictEqual(n.link, '/app/admin/compliance/frameworks?tab=per_automation');
    await run(deps);
    assert.strictEqual(sent.filter(n => /AI Act self-assessment/.test(n.title)).length, 2);
    deps.now = () => NOW + DAY;
    await run(deps);
    assert.strictEqual(sent.filter(n => /AI Act self-assessment/.test(n.title)).length, 3);
});

test('CRA notification (72 h): due soon within 24 h, overdue after, met by the authority notification stamp', async () => {
    const clocks = [
        // detected 60 h ago → the 72 h notification is 12 h out
        { id: 30, kind: 'vulnerability', regimes: ['CRA'], detected_at: at(-60 * HOUR), early_warning_sent_at: at(-50 * HOUR) },
        // detected 80 h ago, still not notified → overdue
        { id: 31, kind: 'security_incident', regimes: ['CRA'], detected_at: at(-80 * HOUR), early_warning_sent_at: at(-70 * HOUR) },
        // notified → the clock is met
        { id: 32, kind: 'vulnerability', regimes: ['CRA'], detected_at: at(-80 * HOUR), early_warning_sent_at: at(-70 * HOUR), authority_notified_at: at(-10 * HOUR) },
        // detected 10 h ago → 62 h out, outside the 24 h window
        { id: 33, kind: 'vulnerability', regimes: ['CRA'], detected_at: at(-10 * HOUR), early_warning_sent_at: at(-5 * HOUR) },
    ];
    const { deps, sent } = harness({ incidentStore: { listNeedingAttention: async () => [], listOpenClocks: async () => clocks } });
    await run(deps);
    const byIncident = (id) => sent.filter(n => n.message.includes(`#${id} `)).map(n => n.title);
    assert.deepStrictEqual(byIncident(30), ['CRA notification (72 h) due soon']);
    assert.deepStrictEqual(byIncident(31), ['CRA notification (72 h) overdue']);
    assert.deepStrictEqual(byIncident(32), []);
    assert.deepStrictEqual(byIncident(33), []);
});

test('the legacy Art. 33 sweep skips CRA-only rows, so a CRA clock is never nudged twice', async () => {
    const { deps, sent } = harness({ incidentStore: {
        listNeedingAttention: async () => [
            { id: 40, kind: 'vulnerability', regimes: ['CRA'], deadline_at: at(10 * HOUR) },
            { id: 41, kind: 'security_incident', regimes: '["CRA"]', deadline_at: at(-HOUR) },
            { id: 42, kind: 'vulnerability', regimes: ['GDPR', 'CRA'], deadline_at: at(10 * HOUR) },
        ],
        listOpenClocks: async () => [],
    } });
    await run(deps);
    const art33 = sent.filter(n => /Art\. 33/.test(n.title));
    assert.deepStrictEqual(art33.map(n => n.message.match(/Incident #(\d+)/)[1]), ['42'], 'only the row that is also a GDPR matter');
});

test('legacy Art. 33 incident sweep is deduped too and names the incident by id, not title', async () => {
    const { deps, sent } = harness({ incidentStore: {
        listNeedingAttention: async () => [{ id: 5, title: 'Laptop of J. Jansen (jan@example.org) stolen', deadline_at: at(10 * HOUR) }],
        listOpenClocks: async () => [],
    } });
    await run(deps);
    await run(deps);
    const inc = sent.filter(n => /Art\. 33/.test(n.title));
    assert.strictEqual(inc.length, 1);
    assert.ok(inc[0].message.includes('Incident #5'));
    assert.ok(!inc[0].message.includes('jan@example.org'));
});

test('without a notify log the tiers still fire (loud beats silent) and the job records a run', async () => {
    const { deps, sent } = harness({
        complianceStore: null,
        dsrStore: { listOpenWithDeadlines: async () => [{ id: 1, request_type: 'access', status: 'pending', due_at: at(2 * DAY) }] },
    });
    jobRuns.length = 0;
    await run(deps);
    await run(deps);
    assert.strictEqual(sent.filter(n => /Data-subject request/.test(n.title)).length, 2);
    assert.strictEqual(jobRuns.length, 2);
    assert.strictEqual(jobRuns[0].job, 'compliance_deadlines');
    assert.strictEqual(jobRuns[0].status, 'ok');
});
