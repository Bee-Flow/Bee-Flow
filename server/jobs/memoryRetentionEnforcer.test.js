/**
 * Memory retention policy resolution.
 *
 * This is the highest-blast-radius switch in the memory work: enabled with a
 * 365-day window, one pass expires every memory older than a year across a
 * tenant, silently, because expiry is a status flip with no user-visible event.
 * So the assertions here are all about it staying OFF unless somebody
 * deliberately turned it on.
 *
 * Note the deliberate asymmetry with the per-user memory master switch, which
 * reads `!== false` because memory defaults ON. This reads `=== true`, because
 * deleting defaults OFF. Each fails towards leaving data alone; getting them
 * the same way round is how an outage becomes either "nobody has memory" or
 * "everybody's memory was swept".
 *
 * Both halves of the policy live in `compliance_settings`, where the admin
 * already records the org's declared retention window — so the number the ROPA
 * publishes and the number this job sweeps on are the same number, and cannot
 * drift into contradicting each other.
 *
 * Run: cd server && node --test jobs/memoryRetentionEnforcer.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Stubs, installed before the job requires them ────────────────────
const stub = (relPath, exports) => {
    const p = require.resolve(relPath);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// Per-org compliance settings, keyed by org id.
const settings = new Map();
let settingsThrow = false;

const queries = [];
stub('../db', {
    run: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 0 }; },
    getOne: async () => null,
    getAll: async () => [],
    exec: async () => {},
    pool: {},
});
stub('../stores/complianceStore', {
    markRetentionRun: async () => true,
    getSettings: async (orgId) => {
        if (settingsThrow) throw new Error('compliance settings unreachable');
        return settings.get(orgId) || { memory_retention_enabled: false, default_retention_days: null };
    },
});
stub('../stores/userStore', { getAllOrganizations: async () => [{ id: 'org-a' }, { id: 'org-b' }] });
stub('../telemetry/metrics', { recordJobRun: () => {} });

const {
    runOnce, getRetentionPolicy,
    DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS,
} = require('./memoryRetentionEnforcer');

/** Record one org's compliance settings. */
const setOrg = (orgId, patch) => settings.set(orgId, {
    memory_retention_enabled: false, default_retention_days: null, ...patch,
});

beforeEach(() => { settings.clear(); queries.length = 0; settingsThrow = false; });

// ── The default ──────────────────────────────────────────────────────

test('an org with no configuration has retention OFF', async () => {
    const policy = await getRetentionPolicy('org-a');
    assert.strictEqual(policy.enabled, false);
});

test('a declared retention window alone does not enable deletion', async () => {
    // THE MIGRATION HAZARD. Orgs have carried `default_retention_days` for a
    // long time as documentation, while the sweep expired nothing. The moment
    // the sweep learned how to work, honouring that number by itself would
    // have expired a year of memories across every one of them, silently.
    setOrg('org-a', { default_retention_days: 365 });
    assert.strictEqual((await getRetentionPolicy('org-a')).enabled, false);
});

test('only an explicit boolean true enables it', async () => {
    // Not 'true', not 1, not 'yes'. A value that arrived as a string from a
    // form post must not silently start deleting.
    for (const value of ['true', 1, 'yes', {}, [], 'on']) {
        setOrg('org-a', { memory_retention_enabled: value });
        const policy = await getRetentionPolicy('org-a');
        assert.strictEqual(policy.enabled, false, `${JSON.stringify(value)} must not enable retention`);
    }
    setOrg('org-a', { memory_retention_enabled: true });
    assert.strictEqual((await getRetentionPolicy('org-a')).enabled, true);
});

test('a settings read failure resolves to OFF, not to the default window', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    settingsThrow = true;
    const policy = await getRetentionPolicy('org-a');
    assert.strictEqual(policy.enabled, false);
});

// ── The window ───────────────────────────────────────────────────────

test('an absent window falls back to the default', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    assert.strictEqual((await getRetentionPolicy('org-a')).days, DEFAULT_RETENTION_DAYS);
});

test('a suspiciously short window is refused rather than honoured', async () => {
    // 30 instead of 300 is a plausible typo, and it would expire almost
    // everything on the next tick.
    for (const days of [MIN_RETENTION_DAYS - 1, 0, -5]) {
        setOrg('org-a', { memory_retention_enabled: true, default_retention_days: days });
        assert.strictEqual(
            (await getRetentionPolicy('org-a')).days, DEFAULT_RETENTION_DAYS,
            `${days} days must not be honoured`,
        );
    }
});

test('the window the ROPA publishes is the window that is swept', async () => {
    // One number, one source. If these could diverge, the org's published
    // record of processing would describe a schedule nothing follows.
    setOrg('org-a', { memory_retention_enabled: true, default_retention_days: 90 });
    assert.strictEqual((await getRetentionPolicy('org-a')).days, 90);
});

// ── The sweep itself ─────────────────────────────────────────────────

test('with every org disabled, no age sweep runs at all', async () => {
    await runOnce();
    const ageSweeps = queries.filter(q => q.sql.includes('last_confirmed_at'));
    assert.strictEqual(ageSweeps.length, 0);
    // The deadline sweep and the heartbeat still run — the job stays alive for
    // the Art-5(1)(e) check.
    assert.ok(queries.some(q => q.sql.includes('expires_at')));
});

test('an enabled org sweeps only its own rows, never another tenant\'s', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    await runOnce();

    const ageSweeps = queries.filter(q => q.sql.includes('last_confirmed_at'));
    assert.strictEqual(ageSweeps.length, 1, 'exactly the one enabled org');
    assert.deepStrictEqual(ageSweeps[0].params, ['org-a', String(DEFAULT_RETENTION_DAYS)]);
    assert.ok(ageSweeps[0].sql.includes('u."organizationId" = $1'));
});

test('the sweep never deletes and never touches instructions', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    await runOnce();
    const sweep = queries.find(q => q.sql.includes('last_confirmed_at'));

    // Expiry is a status flip, so the row survives a subject-access export and
    // stays restorable.
    assert.ok(!/\bDELETE\b/i.test(sweep.sql), 'retention must never DELETE');
    assert.ok(sweep.sql.includes("status = 'expired'"));
    // Standing instructions are directions the user gave on purpose; dropping
    // one changes the assistant's behaviour with no event to connect it to.
    assert.ok(sweep.sql.includes("m.type <> 'instruction'"));
});

test('age is measured from the last confirmation, not from creation', async () => {
    // A preference the user restates every week must never age out, however
    // old the row is. Measuring from created_at would expire exactly the
    // memories that are most reliably true.
    setOrg('org-a', { memory_retention_enabled: true });
    await runOnce();
    const sweep = queries.find(q => q.sql.includes('last_confirmed_at'));
    assert.ok(sweep.sql.includes('COALESCE(m.last_confirmed_at, m.updated_at, m.created_at)'));
});

test('the sweep is bounded so one tenant cannot hold the pool', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    await runOnce();
    const sweep = queries.find(q => q.sql.includes('last_confirmed_at'));
    assert.ok(/LIMIT \d+/.test(sweep.sql));
});
