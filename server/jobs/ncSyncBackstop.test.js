/**
 * ncSyncBackstop — the 24-hour backoff after a failed sync.
 *
 * On prod a handful of orgs with a broken connector (NC proxy 401/404, or
 * "fetch failed") were retried and logged at warn on every 6-hourly tick, on
 * every replica and after every restart, because runFullSync returns before
 * it writes ncLastSyncAt. The backoff now reads the open
 * connector.nc_sync_failed row on org health. What this file pins:
 *
 *   - a failure warns once and the next ticks skip the org (at debug);
 *   - after 24 hours the org is tried again;
 *   - a success resolves the problem, and with it the backoff;
 *   - a manual "Sync now" that succeeds in between lifts the backoff too;
 *   - a health read that fails degrades to "no backoff", never to silence.
 *
 * The real org-health emitter runs on an in-memory store. runFullSync is a
 * stand-in that records its outcome through that emitter the way the real one
 * does (pinned in services/ncUserGroupSync.test.js). Dependencies go in through
 * _setDeps, so no store and no pool is ever loaded.
 *
 * Run: cd server && node --test jobs/ncSyncBackstop.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const orgHealth = require('../services/orgHealth');
const backstop = require('./ncSyncBackstop');

const NC_SYNC_FAILED = 'connector.nc_sync_failed';
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-09-26T08:00:00Z');

let clock = T0;
let orgs = [];
let healthy = new Set();
let syncCalls = [];
let logs = [];
let listThrows = false;
const rows = new Map(); // `${subject}|${code}` -> problem row

// In-memory stand-in for orgHealthStore: the upsert bumps last_seen_at, a
// resolve stamps resolved_at, a listing returns open rows newest first.
const memStore = {
    async upsertProblem({ subjectKey, organizationId, code, category, severity, meta }) {
        const key = `${subjectKey}|${code}`;
        const prev = rows.get(key);
        rows.set(key, {
            subjectKey, organizationId, code, category, severity, meta,
            count: prev ? prev.count + 1 : 1,
            lastSeenAt: new Date(clock),
            resolvedAt: null,
        });
        return { inserted: !prev, reopened: !!(prev && prev.resolvedAt), count: prev ? prev.count + 1 : 1 };
    },
    async appendEvent() { return { id: 'ev' }; },
    async resolveProblems(id, codes) {
        let n = 0;
        for (const r of rows.values()) {
            if ((r.organizationId === id || r.subjectKey === id) && codes.includes(r.code) && !r.resolvedAt) {
                r.resolvedAt = new Date(clock);
                n++;
            }
        }
        return n;
    },
    async listProblems({ code = null, includeResolved = false } = {}) {
        if (listThrows) throw new Error('db down');
        return [...rows.values()]
            .filter(r => (!code || r.code === code) && (includeResolved || !r.resolvedAt))
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    },
};

const ncUserGroupSync = {
    NC_SYNC_FAILED,
    async runFullSync(org) {
        syncCalls.push(org.id);
        if (!healthy.has(org.id)) {
            await orgHealth.problem(NC_SYNC_FAILED, { orgId: org.id, meta: { stage: 'list_users', reason: 'http_401', httpStatus: 401 }, source: 'ncSync' });
            return { error: 'NC proxy /nc/ocs/v2.php/apps/app_api/api/v1/users?format=json HTTP 401' };
        }
        await orgHealth.resolve(org.id, [NC_SYNC_FAILED]);
        return { created: 0, deactivated: 0, groupsCreated: 0, errors: [] };
    },
};

const record = (level) => (...args) => { logs.push({ level, msg: args.join(' ') }); };
const log = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };

const ncOrg = (id) => ({ id, nc_instance_id: `inst-${id}`, nc_sync_mode: 'mirror_all', nc_last_sync_at: null });

test.beforeEach(() => {
    clock = T0;
    orgs = [ncOrg('org-a')];
    healthy = new Set();
    syncCalls = [];
    logs = [];
    listThrows = false;
    rows.clear();
    orgHealth._resetThrottles();
    orgHealth._setStore(memStore);
    orgHealth._setNow(() => clock);
    backstop._setDeps({
        userStore: { getAllOrganizations: async () => orgs },
        ncUserGroupSync,
        orgHealth,
        recordJobRun: () => { },
        log,
        now: () => clock,
    });
});

test.after(() => {
    backstop._setDeps(null);
    orgHealth._setStore(null);
    orgHealth._setNow();
});

const at = (level) => logs.filter(l => l.level === level);

async function tickAt(ms) {
    clock = ms;
    logs = [];
    await backstop.runOnce();
}

test('a failure opens the problem, warns once, and the next tick skips the org', async () => {
    await tickAt(T0);
    assert.deepEqual(syncCalls, ['org-a']);
    assert.equal(at('warn').length, 1);
    assert.match(at('warn')[0].msg, /org=org-a .*HTTP 401.*backing off 24h/);
    const open = await memStore.listProblems({ code: NC_SYNC_FAILED });
    assert.equal(open.length, 1, 'the failure must be visible on org health');

    await tickAt(T0 + 6 * HOUR);
    assert.deepEqual(syncCalls, ['org-a'], 'within 24h the org is not tried again');
    assert.equal(at('warn').length, 0, 'the skip must not warn again');
    assert.equal(at('debug').length, 1);
    assert.match(at('debug')[0].msg, /org=org-a skipped/);

    await tickAt(T0 + 18 * HOUR);
    assert.deepEqual(syncCalls, ['org-a']);
    assert.equal(at('warn').length, 0);
});

test('after 24 hours the org is retried, and a repeat failure opens a new window', async () => {
    await tickAt(T0);
    await tickAt(T0 + 24 * HOUR - 1);
    assert.deepEqual(syncCalls, ['org-a'], 'one millisecond short of the window still backs off');

    await tickAt(T0 + 24 * HOUR);
    assert.deepEqual(syncCalls, ['org-a', 'org-a']);
    assert.equal(at('warn').length, 1, 'one warn per backoff window');

    await tickAt(T0 + 30 * HOUR);
    assert.deepEqual(syncCalls, ['org-a', 'org-a'], 'the second failure restarts the 24h window');
});

test('a success resolves the problem, and the backoff goes with it', async () => {
    await tickAt(T0);
    healthy.add('org-a');

    await tickAt(T0 + 24 * HOUR);
    assert.deepEqual(syncCalls, ['org-a', 'org-a']);
    assert.equal((await memStore.listProblems({ code: NC_SYNC_FAILED })).length, 0, 'success must resolve the problem');
    assert.equal(at('warn').length, 0);

    await tickAt(T0 + 30 * HOUR);
    assert.deepEqual(syncCalls, ['org-a', 'org-a', 'org-a'], 'a healthy org is swept every tick again');
    assert.equal(at('debug').length, 0);
});

test('a manual "Sync now" that succeeds during the backoff lifts it for the next tick', async () => {
    await tickAt(T0);
    // routes/admin/ncSync.js calls runFullSync directly, outside this job, so
    // the backoff never sees it. Its success resolves the shared health row.
    healthy.add('org-a');
    clock = T0 + 2 * HOUR;
    const manual = await ncUserGroupSync.runFullSync(orgs[0]);
    assert.equal(manual.error, undefined, 'the manual sync ran despite the open backoff');

    await tickAt(T0 + 6 * HOUR);
    assert.deepEqual(syncCalls, ['org-a', 'org-a', 'org-a'], 'backstop, manual, backstop');
    assert.equal(at('debug').length, 0, 'nothing left to back off on');
});

test('the backoff is per org: a broken org does not hold back a healthy one', async () => {
    orgs = [ncOrg('org-a'), ncOrg('org-b')];
    healthy.add('org-b');
    await tickAt(T0);
    await tickAt(T0 + 6 * HOUR);
    assert.deepEqual(syncCalls.filter(id => id === 'org-a'), ['org-a']);
    assert.deepEqual(syncCalls.filter(id => id === 'org-b'), ['org-b', 'org-b']);
});

test('an org-health read that fails means no backoff, not a silent skip', async () => {
    await tickAt(T0);
    listThrows = true;
    await tickAt(T0 + 6 * HOUR);
    assert.deepEqual(syncCalls, ['org-a', 'org-a']);
});

test('orgs synced in the last 30 minutes and manual-mode orgs are still left alone', async () => {
    orgs = [
        { ...ncOrg('fresh'), nc_last_sync_at: new Date(T0 - 10 * 60 * 1000).toISOString() },
        { ...ncOrg('manual'), nc_sync_mode: 'manual' },
    ];
    await tickAt(T0);
    assert.deepEqual(syncCalls, []);
});
