/**
 * supportInboxSyncEngine — crash-recovery regressions.
 *
 * The engine's handshake with a mailbox row is: acquireSyncLock (TTL lease) →
 * fetch from the provider → write a TERMINAL sync_status ('idle'/'error') →
 * releaseSyncLock. A hard kill (SIGKILL, OOM, pod eviction) during the provider
 * round-trips runs neither the catch nor the finally, so whatever is durable at
 * that instant is what the next process inherits.
 *
 * These tests pin that the inherited state is always recoverable: only the
 * lease (which the DATABASE expires on its own) may be left behind, never a
 * sync_status the engine can no longer clear. sync_status='syncing' used to be
 * written before the fetch, and getDueInboxes() excludes those rows with
 * `AND sync_status != 'syncing'` — a predicate no lease expiry, PATCH route or
 * re-OAuth clears, so one crash silently retired the mailbox for good.
 *
 * No live DB: the two stores and the provider clients are stubbed via
 * testUtils/stubRequire (keys are the require strings as written inside the
 * module under test). Every fixture gets its own inbox id and its own stub
 * state, keyed off that id, so the cases stay independent whether node:test
 * runs them sequentially or concurrently.
 *
 * Run: node --test services/supportInboxSyncEngine.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');
const { mountGated } = require('../testUtils/gatedStart');

// ── Fixtures: one support_inboxes row + its store behaviour, per inbox id ────

const inboxes = new Map(); // inboxId → fixture

/**
 * Build a support_inboxes row plus the store methods the engine calls, applied
 * to it exactly as the SQL would. `fixture.row` is the durable state at any
 * instant; `fixture.gmail` is what the provider client does.
 */
function makeInbox(id, overrides = {}) {
    const row = {
        id,
        organization_id: 'org-1',
        provider: 'gmail',
        email_address: 'support@example.com',
        active: true,
        encrypted_tokens: 'enc',
        sync_status: 'idle',
        sync_error: null,
        sync_locked_until: null,
        last_sync_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        sync_interval_minutes: 2,
        tokens: { accessToken: 'tok', _inboxId: id }, // _inboxId routes the provider stub
        ...overrides,
    };
    const fixture = {
        row,
        statusWrites: [],
        released: false,
        gmail: async () => { throw new Error('gmail not configured for this fixture'); },
    };
    inboxes.set(id, fixture);
    return fixture;
}

const store = {
    acquireSyncLock: async (id, ttlMinutes) => {
        const { row } = inboxes.get(id);
        const now = Date.now();
        if (row.sync_locked_until && new Date(row.sync_locked_until).getTime() > now) return { acquired: false };
        row.sync_locked_until = new Date(now + ttlMinutes * 60_000).toISOString();
        return { acquired: true };
    },
    releaseSyncLock: async (id) => {
        const f = inboxes.get(id);
        f.released = true;
        f.row.sync_locked_until = null;
    },
    updateSyncState: async (id, patch = {}) => {
        const f = inboxes.get(id);
        f.statusWrites.push(patch);
        if (patch.syncStatus !== undefined) f.row.sync_status = patch.syncStatus;
        if (patch.syncError !== undefined) f.row.sync_error = patch.syncError;
        if (patch.lastSyncAt !== undefined) f.row.last_sync_at = patch.lastSyncAt;
    },
    getInboxWithTokens: async (id) => inboxes.get(id).row,
    updateTokens: async () => {},
    getDueInboxes: async () => { dueReads += 1; return []; },
};
let dueReads = 0;

const restore = installResolveStub({
    '../stores/supportInboxStore': store,
    '../stores/supportStore': {},
    './email/providerClients': {
        gmailClientFromTokens: async (tokens, onRefresh) => inboxes.get(tokens._inboxId).gmail(onRefresh),
        graphFetchFromTokens: async () => { throw new Error('outlook not used in these tests'); },
    },
    './supportMailer': { htmlToText: (s) => s || '' },
    './supportAiResponder': { runAiAutoResponder: async () => null },
});
test.after(() => restore());

/**
 * supportInboxStore.getDueInboxes()'s WHERE clause, evaluated in JS with SQL's
 * three-valued logic. Mirrored here on purpose: the whole point of the fix is
 * that an interrupted sync leaves a row this predicate still selects.
 */
function isDue(row, at = Date.now()) {
    const notSyncing = row.sync_status == null ? null : row.sync_status !== 'syncing';
    return row.active === true
        && row.encrypted_tokens != null
        && notSyncing === true
        && (row.sync_locked_until == null || new Date(row.sync_locked_until).getTime() <= at)
        && (row.last_sync_at == null
            || new Date(row.last_sync_at).getTime() + row.sync_interval_minutes * 60_000 <= at);
}

const engine = require('./supportInboxSyncEngine');

// ── Tests ────────────────────────────────────────────────────────────────────

test('a kill mid-provider-fetch leaves a mailbox the next tick still picks up', async () => {
    const f = makeInbox('inbox-crash');
    let durableAtKill = null;
    f.gmail = async () => {
        // Snapshot the row exactly as a SIGKILL here would leave it: neither
        // syncOneInbox's catch nor its finally gets to run.
        durableAtKill = { ...f.row };
        throw new Error('killed');
    };

    await engine.syncOneInbox({ id: f.row.id });

    assert.ok(durableAtKill, 'the provider client must have been reached');
    assert.notStrictEqual(durableAtKill.sync_status, 'syncing',
        'no in-flight sync_status may be persisted — nothing can clear it after a crash');
    assert.ok(durableAtKill.sync_locked_until, 'the TTL lease is the in-flight marker');

    // While the lease is live the mailbox is (correctly) skipped…
    assert.strictEqual(isDue(durableAtKill), false, 'a live lease must still exclude the mailbox');
    // …and once the DB expires the lease, the mailbox comes back on its own.
    const afterLease = { ...durableAtKill, sync_locked_until: new Date(Date.now() - 1_000).toISOString() };
    assert.strictEqual(isDue(afterLease), true, 'an expired lease must return the mailbox to the tick');
});

test('a successful sync ends at terminal status idle and releases the lease', async () => {
    const f = makeInbox('inbox-ok');
    f.gmail = async () => ({
        users: { messages: { list: async () => ({ data: { messages: [] } }), get: async () => ({ data: {} }) } },
    });

    const count = await engine.syncOneInbox({ id: f.row.id });

    assert.strictEqual(count, 0);
    assert.deepStrictEqual(f.statusWrites.map(w => w.syncStatus), ['idle'],
        'exactly one status write, and it is terminal');
    assert.strictEqual(f.row.sync_error, null);
    assert.strictEqual(f.released, true);
    assert.strictEqual(isDue(f.row, Date.now() + 3 * 60_000), true,
        'after the sync interval the mailbox is due again');
});

test('a failing sync ends at terminal status error, and the mailbox stays schedulable', async () => {
    const f = makeInbox('inbox-err');
    f.gmail = async () => { throw new Error('token expired'); };

    await engine.syncOneInbox({ id: f.row.id });

    assert.deepStrictEqual(f.statusWrites.map(w => w.syncStatus), ['error']);
    assert.match(f.row.sync_error, /token expired/);
    assert.strictEqual(f.released, true);
    assert.strictEqual(isDue(f.row, Date.now() + 3 * 60_000), true,
        "'error' is not filtered out by getDueInboxes — only 'syncing' was");
});

test('a mailbox already leased elsewhere is left completely untouched', async () => {
    const f = makeInbox('inbox-locked', { sync_locked_until: new Date(Date.now() + 5 * 60_000).toISOString() });
    let fetched = false;
    f.gmail = async () => { fetched = true; throw new Error('should not run'); };

    const count = await engine.syncOneInbox({ id: f.row.id });

    assert.strictEqual(count, 0);
    assert.strictEqual(fetched, false, 'the lease is the mutual-exclusion primitive');
    assert.deepStrictEqual(f.statusWrites, [], 'a lock miss must not rewrite sync state');
    assert.strictEqual(f.released, false, "…and must not release someone else's lease");
});

test('BFSF-438: the polling tick and its boot kickoff go through the support module gate', async () => {
    const w = mountGated((opts) => engine.startSupportInboxSync(opts));
    try {
        assert.deepStrictEqual(w.state.consulted.map(c => [c.moduleId, c.fn]), [['support', engine.tickOnce]]);
        assert.deepStrictEqual(w.timers.map(t => t.kind).sort(), ['interval', 'timeout']);

        // Support removed in the Modules panel: neither timer may read a mailbox.
        w.state.active = false;
        dueReads = 0;
        await w.fireAll();
        assert.strictEqual(dueReads, 0, 'a removed Support module still polled mailboxes');

        // Active again: both timers reach the work.
        w.state.active = true;
        await w.fireAll();
        assert.strictEqual(dueReads, 2, 'the gated tick no longer reaches the mailboxes');
    } finally {
        engine.stopSupportInboxSync();
    }
});
