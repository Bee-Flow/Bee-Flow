/**
 * GDPR-Art32-dlp-efficacy — Art. 32(1)(d) effectiveness.
 *
 * The things this file exists to pin, all of which used to land on the same
 * green (or, after the org-scoping fix, on the same false alarm):
 *   1. both counts are scoped to the organisation (one tenant's verdict was
 *      computed from another tenant's traffic);
 *   2. `organization_id` is NULLABLE on both ledgers, so the scope resolves
 *      through the row's USER as well — and it does so identically for the
 *      numerator and the denominator, because an org-scoped event count over a
 *      platform-wide request count is what invents "zero events on real
 *      traffic";
 *   3. traffic that belongs to no nameable organisation is counted apart and,
 *      once it is big enough to be judgeable itself, produces a non-pass that
 *      says so — never a silent pass and never a silent n/a;
 *   3b. EXCEPT when the scope IS the no-organisation bucket ('default' — what
 *      routes/compliance/shared.js resolveOrgId() answers for an account whose
 *      organizationId is '', and what compliance/scheduler.js sweeps on every
 *      install). There, traffic that resolves to no organisation is not a hole
 *      to set aside: it is the scope's own traffic. Scoping the bucket like a
 *      tenant made the check count 0 of the 69 real requests of a single-tenant
 *      admin, answer not_applicable, and drop out of the score entirely
 *      (compliance/score.js excludes not_applicable from the denominator) —
 *      the check vanished on exactly the install that has only that org;
 *   4. "too little traffic to judge" is not a pass;
 *   5. a failed count is not a count of zero — it is its own status with its
 *      own reason, and only the SQLSTATE reaches the evidence.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/gdpr/art32-dlp-efficacy.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
// The org id the platform files org-less traffic under. Not a tenant: the
// bucket. See NO_ORG_ORG_ID in the check, routes/compliance/shared.js
// resolveOrgId() and compliance/scheduler.js.
const NO_ORG = 'default';
// Rows per table plus the `users` table the attribution resolves through.
const fx = { config: {}, counts: {}, users: {}, errors: {}, queries: [], violations: [] };

const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code });

// '' and NULL both mean "no organisation" (users."organizationId" DEFAULT '').
const nz = (v) => (v === '' || v === null || v === undefined ? null : v);

/**
 * A Postgres double that models the SQL the check ACTUALLY emits: the window is
 * pre-applied by the fixture, the WHERE narrowing is applied first, the LEFT
 * JOIN onto `users` resolves a row with no organisation of its own, and the
 * FILTERs are read off the query text. Modelling the text (not the parameter)
 * is the point: a check that stops asking for the no-organisation bucket's own
 * rows then counts 0 of them here, exactly as it did against the live database.
 *
 * Query-shape complaints are RECORDED, not thrown: _countInWindow catches
 * everything getOne throws and turns it into "the count failed", which would
 * bury the real consequence under an SQL-state warning. They are asserted in
 * afterEach instead, so a test fails on the wrong NUMBER first and on the
 * wrong QUERY as well.
 */
const note = (msg) => { if (!fx.violations.includes(msg)) fx.violations.push(msg); };
const want = (ok, msg) => { if (!ok) note(msg); };

// The predicates this check's scoping is made of, spelled exactly.
const RESOLVES_TO_ORG = /\(t\.organization_id = \$1 OR \(\(t\.organization_id IS NULL OR t\.organization_id = ''\) AND NULLIF\(u\."organizationId", ''\) = \$1\)\)/;
const RESOLVES_TO_NOBODY = /\(\(t\.organization_id IS NULL OR t\.organization_id = ''\) AND NULLIF\(u\."organizationId", ''\) IS NULL\)/;
const COUNTS_THE_HOLE = /COUNT\(\*\) FILTER \(WHERE \(t\.organization_id IS NULL OR t\.organization_id = ''\) AND u\.id IS NULL\)::int AS unattributed/;
// The window narrowed to the rows a FILTER could possibly count — redundant for
// the result, not for the plan: it keeps (organization_id, timestamp DESC)
// usable instead of reading the whole 30-day slice under runner.js's 30 s budget.
const NARROWED = /WHERE t\.timestamp >= NOW\(\) - INTERVAL '30 days' AND \(t\.organization_id = \$1 OR \(t\.organization_id IS NULL OR t\.organization_id = ''\)\)/;

const fakeDb = {
    async getOne(sql, params = []) {
        const flat = String(sql).replace(/\s+/g, ' ').trim();
        const table = /FROM (\w+)/.exec(flat)[1];
        fx.queries.push({ table, sql: flat, params });
        if (fx.errors[table]) throw fx.errors[table];
        const rows = fx.counts[table] || [];
        const scoped = /\$1/.test(flat);
        want(scoped === (params.length === 1), `${table}: the org predicate and its parameter must travel together`);
        if (!scoped) return { c: rows.length, unattributed: 0 };

        // What the query SHOULD look like for this scope...
        const isBucketScope = params[0] === NO_ORG;
        want(/LEFT JOIN users u ON u\.id = t\.user_id/.test(flat), `${table} is counted without resolving the row's user`);
        want(NARROWED.test(flat), `${table} reads the whole window instead of the rows this scope could own`);
        want(RESOLVES_TO_ORG.test(flat), `${table} does not attribute a NULL organization_id through the row's user`);
        if (isBucketScope) {
            want(RESOLVES_TO_NOBODY.test(flat), `${table}: the no-organisation bucket does not claim the rows that resolve to no organisation`);
            want(/0 AS unattributed/.test(flat), `${table}: nothing is a hole in the bucket — it is where the holes live`);
        } else {
            want(!RESOLVES_TO_NOBODY.test(flat), `${table}: a real tenant must not inherit the rows that belong to no organisation`);
            want(COUNTS_THE_HOLE.test(flat), `${table} does not count what cannot be attributed`);
        }

        // ...and what it DOES ask for, which is what gets counted.
        const byOrg = RESOLVES_TO_ORG.test(flat);
        const byNobody = RESOLVES_TO_NOBODY.test(flat);
        const rowOrg = (r) => nz(r.organization_id);
        const orgOf = (r) => rowOrg(r) ?? nz(fx.users[r.user_id]);
        const hasUser = (r) => Object.prototype.hasOwnProperty.call(fx.users, r.user_id);
        const candidates = NARROWED.test(flat)
            ? rows.filter(r => rowOrg(r) === params[0] || rowOrg(r) === null)
            : rows;
        return {
            // `c`, not `attributed`: see the note on the SQL in the check — the
            // smoke double in compliance/__tests__/ answers under that name too.
            c: candidates.filter(r => (byOrg && orgOf(r) === params[0]) || (byNobody && orgOf(r) === null)).length,
            unattributed: COUNTS_THE_HOLE.test(flat)
                ? candidates.filter(r => rowOrg(r) === null && !hasUser(r)).length
                : 0,
        };
    },
};

const fakeConfigStore = { async getConfig(key) { return fx.config[key] ?? null; } };

const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/configStore': fakeConfigStore,
});
const check = require('./art32-dlp-efficacy');
test.after(() => restore());

// n rows as they really land: an explicit organization_id, or NULL with the
// user the row was written for (App Studio / app-run rows do exactly this).
const rows = (n, row) => Array.from({ length: n }, () => ({ organization_id: null, user_id: null, ...row }));

test.beforeEach(() => {
    fx.config = { [`org_privacy_shield_${ORG}`]: { enabled: true } };
    fx.counts = {};
    fx.users = {};
    fx.errors = {};
    fx.queries = [];
    fx.violations = [];
});

// A wrong query is a finding of its own, reported after the verdict it produced.
test.afterEach(() => {
    if (fx.violations.length) {
        assert.fail(`the emitted SQL is not the query this scope needs:\n  - ${fx.violations.join('\n  - ')}`);
    }
});

test('DLP off → not_applicable, and no ledger is read', async () => {
    fx.config = {};
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(fx.queries.length, 0);
});

test('the verdict is computed from THIS org\'s traffic only', async () => {
    // Another tenant is busy and its shield fires; this tenant is quiet.
    fx.counts.ai_usage_log = [...rows(500, { organization_id: 'org-b' }), ...rows(3, { organization_id: ORG })];
    fx.counts.guardrail_events = [...rows(40, { organization_id: 'org-b' })];
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.ai_requests, 3, 'org-b traffic must not count for org-a');
    assert.equal(r.evidence.guardrail_events, 0, "org-b's guardrail events are not org-a's evidence");
    assert.equal(r.evidence.org_scoped, true);
    for (const q of fx.queries) assert.deepEqual(q.params, [ORG]);
    // And the reverse: org-b has the traffic and the events.
    fx.config['org_privacy_shield_org-b'] = { enabled: true };
    fx.queries = [];
    const b = await check.evaluate('org-b');
    assert.equal(b.status, 'pass');
    assert.equal(b.evidence.ai_requests, 500);
    assert.equal(b.evidence.guardrail_events, 40);
});

test('a NULL organization_id is resolved through the row\'s user — app-run traffic is this org\'s traffic', async () => {
    // organization_id is NULLABLE and routinely NULL (usageStore.logUsage binds
    // `entry.organization_id || null`; an owner's unpublished app writes NULL).
    // Scoping on the column alone put this workspace under MIN_TRAFFIC and the
    // check answered not_applicable forever.
    fx.users = { 'u-1': ORG, 'u-2': ORG };
    fx.counts.ai_usage_log = rows(500, { organization_id: null, user_id: 'u-1' });
    fx.counts.guardrail_events = rows(12, { organization_id: null, user_id: 'u-2' });
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.ai_requests, 500, 'rows with a NULL org but a user of this org are this org\'s rows');
    assert.equal(r.evidence.guardrail_events, 12);
    assert.equal(r.evidence.unattributable_ai_requests, 0);
    assert.equal(r.status, 'pass');
});

test('the two counts are attributable on the SAME basis — an org-tagged denominator never faces an untagged numerator', async () => {
    // The inverse consequence: usage rows carry the org, guardrail rows don't.
    // Comparing the two on different bases reported "real traffic produces zero
    // guardrail events" at a shield that was working.
    fx.users = { 'u-1': ORG };
    fx.counts.ai_usage_log = rows(500, { organization_id: ORG, user_id: 'u-1' });
    fx.counts.guardrail_events = rows(12, { organization_id: null, user_id: 'u-1' });
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.guardrail_events, 12, 'the shield fired; the events were only logged without an org');
    assert.notEqual(r.status, 'warn', 'a working shield must not be reported as silent');
    assert.equal(r.status, 'pass');
});

test('resolving through the user does not leak another tenant in', async () => {
    fx.users = { 'u-a': ORG, 'u-b': 'org-b' };
    fx.counts.ai_usage_log = [...rows(500, { user_id: 'u-b' }), ...rows(30, { user_id: 'u-a' })];
    fx.counts.guardrail_events = [...rows(40, { user_id: 'u-b' }), ...rows(2, { user_id: 'u-a' })];
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.ai_requests, 30);
    assert.equal(r.evidence.guardrail_events, 2);
    assert.equal(r.evidence.unattributable_ai_requests, 0, 'a row of a user who HAS an org is attributed, not unattributable');
    assert.equal(r.status, 'pass');
});

test('a user without an organisation is "not this org", not a hole in the attribution', async () => {
    fx.users = { 'u-a': ORG, 'u-solo': '' }; // users."organizationId" DEFAULT ''
    fx.counts.ai_usage_log = [...rows(500, { user_id: 'u-solo' }), ...rows(30, { user_id: 'u-a' })];
    fx.counts.guardrail_events = rows(2, { user_id: 'u-a' });
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.ai_requests, 30);
    assert.equal(r.evidence.unattributable_ai_requests, 0, 'that traffic is determinately no-org, so it must not flip this verdict');
    assert.equal(r.status, 'pass');
});

test('traffic that belongs to nobody nameable is never a silent n/a — it is a warn that says so', async () => {
    fx.users = { 'u-a': ORG };
    // No organisation and no user to resolve one through (deleted user / system row).
    fx.counts.ai_usage_log = [...rows(400, { user_id: null }), ...rows(5, { user_id: 'u-a' })];
    fx.counts.guardrail_events = [];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.ai_requests, 5);
    assert.equal(r.evidence.unattributable_ai_requests, 400);
    assert.equal(r.evidence.attribution_complete, false);
    assert.match(r.details, /400 request\(s\) carry no organisation/);
    assert.doesNotMatch(r.details, /too little traffic/, 'the honest answer names the attribution hole, not the volume');
});

test('traffic that belongs to nobody nameable is never a silent pass either', async () => {
    fx.users = { 'u-a': ORG };
    fx.counts.ai_usage_log = [...rows(400, { user_id: 'ghost' }), ...rows(100, { user_id: 'u-a' })];
    fx.counts.guardrail_events = rows(12, { user_id: 'u-a' });
    const r = await check.evaluate(ORG);
    assert.notEqual(r.status, 'pass', 'a population big enough to judge was never judged');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.ai_requests, 100);
    assert.equal(r.evidence.unattributable_ai_requests, 400);
    assert.equal(r.evidence.attribution_complete, false);
    assert.match(r.details, /400 further request\(s\)/);
});

test('a hole too small to judge does not flip the verdict, but is still named', async () => {
    fx.users = { 'u-a': ORG };
    fx.counts.ai_usage_log = [...rows(4, { user_id: null }), ...rows(100, { user_id: 'u-a' })];
    fx.counts.guardrail_events = rows(12, { user_id: 'u-a' });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.unattributable_ai_requests, 4);
    assert.match(r.details, /4 request\(s\)/, 'the blind spot is reported even when it does not change the status');
});

test('zero events for this org, while events exist that nobody can be named for → warn that says both', async () => {
    fx.users = { 'u-a': ORG };
    fx.counts.ai_usage_log = rows(500, { user_id: 'u-a' });
    fx.counts.guardrail_events = rows(9, { user_id: null });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.guardrail_events, 0);
    assert.equal(r.evidence.unattributable_guardrail_events, 9);
    assert.match(r.details, /zero events/);
    assert.match(r.details, /9 guardrail event\(s\)/);
});

test('too little traffic to judge is NOT a pass — it is not_applicable with the reason', async () => {
    fx.counts.ai_usage_log = rows(3, { organization_id: ORG });
    fx.counts.guardrail_events = [];
    const r = await check.evaluate(ORG);
    assert.notEqual(r.status, 'pass', 'the subject of the check is effectiveness; nothing was demonstrated');
    assert.equal(r.status, 'not_applicable');
    assert.match(r.details, /too little traffic/);
    assert.equal(r.evidence.ai_requests, 3);
    assert.equal(r.evidence.min_traffic, 25);
});

test('a failed count is not a count of zero: warn naming the SQL state, never a pass', async () => {
    fx.counts.ai_usage_log = rows(500, { organization_id: ORG });
    fx.counts.guardrail_events = rows(12, { organization_id: ORG });
    fx.errors.guardrail_events = pgError('57014'); // statement timeout
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.counts_readable, false);
    assert.equal(r.evidence.guardrail_events, null, 'unknown stays unknown — never 0');
    assert.equal(r.evidence.unattributable_guardrail_events, null);
    assert.match(r.details, /57014/);
    assert.match(r.details, /could not be counted/);

    // The same for the traffic ledger, and a dropped connection reads the same way.
    fx.errors = { ai_usage_log: pgError('08006') };
    const t = await check.evaluate(ORG);
    assert.equal(t.status, 'warn');
    assert.equal(t.evidence.ai_requests, null);
});

test('a driver message never reaches the evidence — only the SQL state', async () => {
    fx.errors.ai_usage_log = Object.assign(
        new Error("canceling statement: SELECT ... WHERE user_id = 'jan@example.org'"),
        { code: '57014' },
    );
    const r = await check.evaluate(ORG);
    assert.doesNotMatch(JSON.stringify(r.evidence) + ' ' + r.details, /@|SELECT/);
    assert.match(r.details, /57014/);
});

test('the evidence carries counts only — no user, no id, nothing from a row (BFSF-441)', async () => {
    fx.users = { 'u-jan': ORG };
    fx.counts.ai_usage_log = rows(500, { user_id: 'u-jan' });
    fx.counts.guardrail_events = rows(12, { user_id: 'u-jan' });
    const r = await check.evaluate(ORG);
    const blob = JSON.stringify(r.evidence) + ' ' + r.details;
    assert.doesNotMatch(blob, /u-jan|@/, 'a user id is personal data — it belongs nowhere near the evidence chain');
    assert.deepEqual(Object.keys(r.evidence).sort(), [
        'ai_requests', 'attribution', 'dlp_enabled', 'guardrail_events', 'min_traffic',
        'no_org_bucket', 'org_scoped', 'unattributable_ai_requests', 'unattributable_guardrail_events',
        'window_days',
    ], 'the evidence is an explicit allow-list of fields, not a row with keys removed');
});

test('a ledger that does not exist yet → not_applicable, distinct from a failed read', async () => {
    fx.errors.guardrail_events = pgError('42P01');
    fx.counts.ai_usage_log = rows(500, { organization_id: ORG });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence.ledgers_missing, ['guardrail_events']);
    assert.match(r.details, /does not exist on this install/);
});

test('real traffic with a silent shield → warn; traffic with events → pass', async () => {
    fx.counts.ai_usage_log = rows(500, { organization_id: ORG });
    fx.counts.guardrail_events = [];
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /zero events/);

    fx.counts.guardrail_events = rows(12, { organization_id: ORG });
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.guardrail_events, 12);
});

test('without an org in scope the counts stay install-wide (single-tenant sweep)', async () => {
    fx.config = { ai: { moderationEnabled: true } };
    fx.counts.ai_usage_log = [...rows(400, { organization_id: 'org-a' }), ...rows(100, { user_id: null })];
    fx.counts.guardrail_events = rows(5, { organization_id: 'org-a' });
    const r = await check.evaluate(null);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.ai_requests, 500, 'the install IS the population — nothing is out of scope');
    assert.equal(r.evidence.unattributable_ai_requests, 0);
    assert.equal(r.evidence.org_scoped, false);
    for (const q of fx.queries) assert.deepEqual(q.params, []);
});

// ---------------------------------------------------------------------------
// The no-organisation bucket ('default').
//
// This is the scope compliance/scheduler.js sweeps on EVERY install and the one
// routes/compliance/shared.js resolveOrgId() hands the admin of a single-tenant
// install (users."organizationId" is '' for migrated and bootstrapped accounts,
// stores/user/schema.js). Scoped like a tenant it matched nothing, so the check
// answered not_applicable — and compliance/score.js drops not_applicable from
// the denominator, so Art. 32(1)(d) effectiveness silently left the score of
// the install that had only that one scope. The fixture below is the shape of
// the dev database that proved it: 1124 requests / 109 events in the window, 69
// requests and 15 events of them written for an admin whose organizationId is ''.
// ---------------------------------------------------------------------------

const REAL = 'org-live';
// Both scopes have the shield on, so neither answer is a configuration artefact.
const bothScopes = () => ({
    [`org_privacy_shield_${NO_ORG}`]: { enabled: true },
    [`org_privacy_shield_${REAL}`]: { enabled: true },
});

test('the no-organisation bucket sees its OWN traffic — the single-tenant install does not vanish from the score', async () => {
    fx.config = bothScopes();
    fx.users = { 'u-admin': '' }; // users."organizationId" DEFAULT '' → resolveOrgId() answers 'default'
    fx.counts.ai_usage_log = [...rows(1055, { organization_id: REAL }), ...rows(69, { user_id: 'u-admin' })];
    fx.counts.guardrail_events = [...rows(94, { organization_id: REAL }), ...rows(15, { user_id: 'u-admin' })];

    const r = await check.evaluate(NO_ORG);
    assert.equal(r.evidence.ai_requests, 69, "the bucket's own traffic is the bucket's traffic, not somebody else's");
    assert.equal(r.evidence.guardrail_events, 15);
    assert.equal(r.evidence.no_org_bucket, true);
    assert.equal(r.evidence.unattributable_ai_requests, 0, 'nothing is unattributable here — the bucket IS where the unattributable lives');
    assert.notEqual(r.status, 'not_applicable', 'a check that answers n/a here leaves the score silently (score.js drops n/a from the denominator)');
    assert.equal(r.status, 'pass');
    assert.doesNotMatch(r.details, /too little traffic/);
});

test('a real tenant still cannot see the bucket, and the bucket cannot see the tenant', async () => {
    fx.config = bothScopes();
    fx.users = { 'u-admin': '', 'u-real': REAL };
    // Both tenants also write rows with a NULL organization_id (app runs).
    fx.counts.ai_usage_log = [...rows(1055, { user_id: 'u-real' }), ...rows(69, { user_id: 'u-admin' })];
    fx.counts.guardrail_events = [...rows(94, { user_id: 'u-real' }), ...rows(15, { user_id: 'u-admin' })];

    const tenant = await check.evaluate(REAL);
    assert.equal(tenant.evidence.ai_requests, 1055, "the bucket's 69 requests are not this tenant's");
    assert.equal(tenant.evidence.guardrail_events, 94);
    assert.equal(tenant.evidence.no_org_bucket, false);
    assert.equal(tenant.evidence.unattributable_ai_requests, 0, 'a row of a user who exists but has no org is determinately NOT this tenant, not a hole');

    const bucket = await check.evaluate(NO_ORG);
    assert.equal(bucket.evidence.ai_requests, 69, "the tenant's 1055 requests are not the bucket's");
    assert.equal(bucket.evidence.guardrail_events, 15);
});

test('an org-less row of a user who belongs to a real tenant never counts toward the bucket', async () => {
    fx.config = bothScopes();
    fx.users = { 'u-real': REAL };
    fx.counts.ai_usage_log = rows(500, { user_id: 'u-real' }); // NULL organization_id, real org via the user
    fx.counts.guardrail_events = rows(40, { user_id: 'u-real' });

    const r = await check.evaluate(NO_ORG);
    assert.equal(r.evidence.ai_requests, 0, 'resolving to a different, non-empty org means it is not the bucket\'s');
    assert.equal(r.evidence.guardrail_events, 0);
    assert.equal(r.status, 'not_applicable');
    assert.match(r.details, /traffic that belongs to no organisation/, 'the bucket is not "this organisation" — the sentence must say which population is empty');
    assert.doesNotMatch(r.details, /for this organisation/);
});

test('the bucket claims rows with no resolvable user too — and then it is a verdict, not a hole', async () => {
    fx.config = bothScopes();
    fx.users = {}; // the user was deleted, or the row never had one (system / app run)
    fx.counts.ai_usage_log = rows(60, { user_id: null });
    fx.counts.guardrail_events = [];

    const r = await check.evaluate(NO_ORG);
    assert.equal(r.evidence.ai_requests, 60, 'a row nobody can be named for belongs to the bucket — that is what the bucket is');
    assert.equal(r.evidence.unattributable_ai_requests, 0);
    assert.equal(r.status, 'warn', '60 requests and a silent shield is a finding, not "cannot judge"');
    assert.match(r.details, /zero events for traffic that belongs to no organisation/);
    assert.equal(r.evidence.attribution_complete, undefined, 'the attribution is not broken here — the bucket judged that traffic');
    assert.match(r.evidence.attribution, /belongs to this bucket/, 'the evidence says on what basis these rows were claimed');
});

test('the bucket also holds rows that name it outright, and users recorded as belonging to it', async () => {
    fx.config = bothScopes();
    fx.users = { 'u-d': NO_ORG }; // an account whose organizationId was written as the literal fallback
    fx.counts.ai_usage_log = [...rows(300, { organization_id: NO_ORG }), ...rows(200, { user_id: 'u-d' })];
    fx.counts.guardrail_events = rows(12, { organization_id: NO_ORG });

    const r = await check.evaluate(NO_ORG);
    assert.equal(r.evidence.ai_requests, 500);
    assert.equal(r.evidence.guardrail_events, 12);
    assert.equal(r.status, 'pass');
});

test('every row of a window lands in exactly one scope across a scheduler sweep', async () => {
    // scheduler.js sweeps 'default' plus every organisation. The three scopes
    // below must partition the window: no row counted twice, none left over.
    fx.config = { ...bothScopes(), 'org_privacy_shield_org-b': { enabled: true } };
    fx.users = { 'u-admin': '', 'u-real': REAL, 'u-b': 'org-b' };
    const all = [
        ...rows(40, { organization_id: REAL }),
        ...rows(30, { user_id: 'u-real' }),
        ...rows(25, { user_id: 'u-b' }),
        ...rows(35, { user_id: 'u-admin' }),
        ...rows(20, { user_id: null }),
    ];
    fx.counts.ai_usage_log = all;
    fx.counts.guardrail_events = rows(5, { organization_id: REAL });

    const seen = [];
    for (const scope of [NO_ORG, REAL, 'org-b']) seen.push((await check.evaluate(scope)).evidence.ai_requests);
    assert.deepEqual(seen, [55, 70, 25], 'bucket 35+20, tenant 40+30, org-b 25');
    assert.equal(seen.reduce((a, b) => a + b, 0), all.length, 'the scopes partition the window — nothing double-counted, nothing dropped');
});
