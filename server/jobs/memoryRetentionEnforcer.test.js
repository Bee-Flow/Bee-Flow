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
 * The sweeps run on a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js) behind db.js's pool, recorded by
 * testUtils/routeHarness.js; the settings and the organisation list are this
 * job's inputs and stay stubbed.
 *
 * Run: cd server && node --test jobs/memoryRetentionEnforcer.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { failReads } = require('../testUtils/pgliteFaults');
const { recordDb } = require('../testUtils/routeHarness');

const pg = ladderPglite();
const rec = recordDb(undefined, { pg });

// ── Stubs, installed before the job requires them ────────────────────
const stub = (relPath, exports) => {
    const p = require.resolve(relPath);
    require.cache[p] = /** @type {any} */ ({ id: p, filename: p, loaded: true, exports });
};

// Per-org compliance settings, keyed by org id.
const settings = new Map();
let settingsThrow = false;
const heartbeats = [];
stub('../stores/complianceStore', {
    markRetentionRun: async (orgId) => { heartbeats.push(orgId); return true; },
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
    HARD_DELETE_DAYS, HARD_DELETE_BATCH, HARD_DELETE_RUN_CAP,
} = require('./memoryRetentionEnforcer');

/** Record one org's compliance settings. */
const setOrg = (orgId, patch) => settings.set(orgId, {
    memory_retention_enabled: false, default_retention_days: null, ...patch,
});

const DAY = 864e5;
const ago = (days) => new Date(Date.now() - days * DAY);
let seq = 0;
/** A memory of `user` (u-a in org-a, u-b in org-b) with one source row. */
async function memory(over = {}) {
    const id = `m${++seq}`;
    await insertRow(pg, 'user_memories', { id, user_id: 'u-a', type: 'fact', content: 'c', status: 'active', created_at: ago(1), updated_at: ago(1), ...over });
    await insertRow(pg, 'memory_sources', { id: `s-${id}`, memory_id: id, conversation_id: 'conv' });
    return id;
}
const statusOf = async (id) => (await pg.query('SELECT status FROM user_memories WHERE id = $1', [id])).rows[0]?.status ?? 'gone';
const sourcesOf = async (id) => (await pg.query('SELECT count(*)::int AS n FROM memory_sources WHERE memory_id = $1', [id])).rows[0].n;
const hardDeleteStatements = () => rec.queries.filter((q) => /DELETE FROM user_memories/.test(q));

before(async () => {
    await insertRow(pg, 'users', { id: 'u-a', username: 'a', organizationId: 'org-a' });
    await insertRow(pg, 'users', { id: 'u-b', username: 'b', organizationId: 'org-b' });
});
after(() => pg.close());
beforeEach(async () => {
    settings.clear(); settingsThrow = false; heartbeats.length = 0;
    await pg.exec('TRUNCATE user_memories, memory_sources');
    rec.reset();
});

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

test('with every org disabled, no age sweep runs, but the deadline sweep and the heartbeat do', async () => {
    const old = await memory({ last_confirmed_at: ago(500), updated_at: ago(500), created_at: ago(500) });
    const due = await memory({ expires_at: ago(1) });
    const notYet = await memory({ expires_at: new Date(Date.now() + DAY) });
    await runOnce();
    assert.strictEqual(await statusOf(old), 'active', 'no org enabled: nothing ages out');
    // The deadline sweep and the heartbeat still run — the job stays alive for
    // the Art-5(1)(e) check.
    assert.strictEqual(await statusOf(due), 'expired', 'a row past its own TTL expires anyway');
    assert.strictEqual(await statusOf(notYet), 'active');
    assert.deepStrictEqual([...heartbeats].sort(), ['default', 'org-a', 'org-b']);
});

test('an enabled org sweeps only its own rows, never another tenant\'s', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    const mine = await memory({ last_confirmed_at: ago(DEFAULT_RETENTION_DAYS + 1) });
    const theirs = await memory({ user_id: 'u-b', last_confirmed_at: ago(DEFAULT_RETENTION_DAYS + 1) });
    const young = await memory({ last_confirmed_at: ago(DEFAULT_RETENTION_DAYS - 1) });
    await runOnce();
    assert.strictEqual(await statusOf(mine), 'expired');
    assert.strictEqual(await statusOf(theirs), 'active', 'org-b did not enable retention');
    assert.strictEqual(await statusOf(young), 'active', 'inside the window');
});

test('the sweep never deletes and never touches instructions', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    const fact = await memory({ last_confirmed_at: ago(400) });
    const instruction = await memory({ type: 'instruction', last_confirmed_at: ago(400) });
    await runOnce();
    // Expiry is a status flip, so the row survives a subject-access export and
    // stays restorable.
    assert.strictEqual(await statusOf(fact), 'expired');
    assert.strictEqual(await sourcesOf(fact), 1, 'retention never deletes');
    // Standing instructions are directions the user gave on purpose.
    assert.strictEqual(await statusOf(instruction), 'active');
});

test('age is measured from the last confirmation, not from creation', async () => {
    // A preference the user restates every week must never age out, however
    // old the row is.
    setOrg('org-a', { memory_retention_enabled: true });
    const restated = await memory({ created_at: ago(1000), updated_at: ago(1000), last_confirmed_at: ago(3) });
    const neverConfirmed = await memory({ created_at: ago(1000), updated_at: ago(400), last_confirmed_at: null });
    await runOnce();
    assert.strictEqual(await statusOf(restated), 'active');
    assert.strictEqual(await statusOf(neverConfirmed), 'expired', 'without a confirmation the last update counts');
});

test('the age sweep is bounded per statement, oldest first', async () => {
    setOrg('org-a', { memory_retention_enabled: true });
    await pg.query(`INSERT INTO user_memories (id, user_id, type, content, status, last_confirmed_at)
        SELECT 'bulk-' || g, 'u-a', 'fact', 'c', 'active', NOW() - ((400 + g) * INTERVAL '1 day') FROM generate_series(1, 5001) g`);
    await runOnce();
    const { rows } = await pg.query(`SELECT id FROM user_memories WHERE status = 'active'`);
    assert.deepStrictEqual(rows.map((r) => r.id), ['bulk-1'], 'one statement takes at most 5000, the oldest first');
});

// ── The hard-delete pass ─────────────────────────────────────────────

test('history older than 90 days is hard-deleted, on every install, with its sources', async () => {
    // No org enabled retention: this pass is storage limitation for rows that
    // are not memory any more, and does not depend on the org switch.
    assert.strictEqual(HARD_DELETE_DAYS, 90);
    const oldHistory = await memory({ status: 'superseded', valid_to: ago(91) });
    const youngHistory = await memory({ status: 'superseded', valid_to: ago(89) });
    const legacyHistory = await memory({ status: 'superseded', valid_to: null, updated_at: ago(100) });
    const oldArchived = await memory({ status: 'archived', archived_at: ago(400), updated_at: ago(400), created_at: ago(400) });
    const oldExpired = await memory({ status: 'expired', updated_at: ago(400) });
    const oldActive = await memory({ status: 'active', created_at: ago(400), updated_at: ago(400) });
    const oldPending = await memory({ status: 'pending_review', created_at: ago(400), updated_at: ago(400) });
    await runOnce();
    assert.strictEqual(await statusOf(oldHistory), 'gone');
    assert.strictEqual(await sourcesOf(oldHistory), 0, 'sources go in the same statement');
    assert.strictEqual(await statusOf(legacyHistory), 'gone', 'a legacy row ages from its last update');
    assert.strictEqual(await statusOf(youngHistory), 'superseded');
    assert.strictEqual(await statusOf(oldArchived), 'archived', 'restorable memories are not history');
    assert.strictEqual(await statusOf(oldExpired), 'expired');
    assert.strictEqual(await statusOf(oldActive), 'active', 'live rows are never touched');
    assert.strictEqual(await statusOf(oldPending), 'pending_review');
});

test('archived and expired rows are hard-deleted only for an org with retention ON, with its own window', async () => {
    const a1 = await memory({ status: 'archived', archived_at: ago(201) });
    const a2 = await memory({ status: 'expired', updated_at: ago(201) });
    const aYoung = await memory({ status: 'archived', archived_at: ago(199) });
    const b1 = await memory({ user_id: 'u-b', status: 'archived', archived_at: ago(400) });
    await runOnce();
    assert.strictEqual(await statusOf(a1), 'archived', 'no org enabled: nothing restorable is deleted');

    setOrg('org-a', { memory_retention_enabled: true, default_retention_days: 200 });
    setOrg('org-b', { memory_retention_enabled: 'true', default_retention_days: 200 }); // not === true
    await runOnce();
    assert.strictEqual(await statusOf(a1), 'gone');
    assert.strictEqual(await sourcesOf(a1), 0);
    assert.strictEqual(await statusOf(a2), 'gone');
    assert.strictEqual(await statusOf(aYoung), 'archived', 'inside the org\'s own window');
    assert.strictEqual(await statusOf(b1), 'archived', 'org-b did not enable retention');
});

test('a too-short declared window falls back to the default for the restorable delete too', async () => {
    setOrg('org-a', { memory_retention_enabled: true, default_retention_days: 30 });
    const inDefault = await memory({ status: 'archived', archived_at: ago(DEFAULT_RETENTION_DAYS - 1) });
    const pastDefault = await memory({ status: 'archived', archived_at: ago(DEFAULT_RETENTION_DAYS + 1) });
    await runOnce();
    assert.strictEqual(await statusOf(inDefault), 'archived', 'a 30-day typo is not honoured');
    assert.strictEqual(await statusOf(pastDefault), 'gone');
});

/** `n` superseded rows older than the hard-delete window. */
const oldHistory = (n) => pg.query(`INSERT INTO user_memories (id, user_id, type, content, status, valid_to)
    SELECT 'h-' || g, 'u-a', 'fact', 'c', 'superseded', NOW() - INTERVAL '100 days' FROM generate_series(1, $1::int) g`, [n]);
const historyLeft = async () => (await pg.query(`SELECT count(*)::int AS n FROM user_memories WHERE status = 'superseded'`)).rows[0].n;

test('the hard delete runs in batches, stops at a short batch, and is capped per run', async () => {
    await oldHistory(2 * HARD_DELETE_BATCH + 7);
    await runOnce();
    assert.strictEqual(hardDeleteStatements().length, 3, 'two full batches and the short one');
    assert.strictEqual(await historyLeft(), 0);

    await pg.exec('TRUNCATE user_memories, memory_sources');
    await oldHistory(HARD_DELETE_RUN_CAP + 5);
    rec.reset();
    await runOnce();
    assert.strictEqual(hardDeleteStatements().length, HARD_DELETE_RUN_CAP / HARD_DELETE_BATCH);
    assert.strictEqual(await historyLeft(), 5, 'the rest waits for the next run');
});

test('a failing hard delete does not stop the job (the heartbeat still runs)', async () => {
    await memory({ status: 'superseded', valid_to: ago(100) });
    const restore = await failReads(pg, 'memory_sources', '57014', 'canceling statement due to statement timeout');
    try {
        await runOnce();
    } finally { await restore(); }
    assert.strictEqual(hardDeleteStatements().length, 1, 'one attempt, no retry loop');
    assert.deepStrictEqual([...heartbeats].sort(), ['default', 'org-a', 'org-b']);
});
