const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'orgescrow-unit-test-master-key-32chars!!';

// ── In-memory stand-ins for the two lazily-required modules ─────────────────
const orgs = new Map();   // orgId -> { id, org_root_key, org_key_version }
const users = new Map();  // userId -> row

function seedOrg(id) { orgs.set(id, { id, org_root_key: null, org_key_version: 1 }); }

// Rows in the `config` table, keyed by config key. Deliberately SEPARATE from
// `secrets` (the decrypted view configStore exposes): the whole point of the
// undecryptable-key case is that a row exists while getSecret answers null.
const configRows = new Set();

const dbMock = {
    async getOne(sql, params) {
        if (/FROM organizations/i.test(sql)) {
            const o = orgs.get(params[0]);
            return o ? { ...o } : null;
        }
        if (/FROM config/i.test(sql)) {
            return configRows.has(params[0]) ? { present: 1 } : null;
        }
        return null;
    },
    async getAll(sql, params) {
        if (/FROM users/i.test(sql)) {
            return [...users.values()]
                .filter(u => u.organizationId === params[0] && u.orgWrappedDEK)
                .map(u => ({ id: u.id, orgWrappedDEK: u.orgWrappedDEK }));
        }
        return [];
    },
    async run(sql, params) {
        if (/UPDATE organizations/i.test(sql)) {
            const guarded = /org_root_key" IS NULL/i.test(sql);
            const id = params[1];
            const o = orgs.get(id);
            if (!o) return { rowCount: 0 };
            if (guarded && o.org_root_key) return { rowCount: 0 };
            o.org_root_key = params[0];
            if (/\+ 1/.test(sql)) o.org_key_version = (o.org_key_version || 1) + 1;
            return { rowCount: 1 };
        }
        // Set-if-absent on the user escrow envelope. The guard is the point of
        // the statement — two concurrent first-touches must not be able to
        // overwrite each other's key — so the mock has to honour it rather than
        // rubber-stamp the write.
        if (/UPDATE users/i.test(sql) && /"orgWrappedDEK"/i.test(sql)) {
            const guarded = /orgWrappedDEK" IS NULL/i.test(sql);
            const u = users.get(params[1]);
            if (!u) return { rowCount: 0 };
            if (guarded && u.orgWrappedDEK) return { rowCount: 0 };
            u.orgWrappedDEK = params[0];
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
};

const userStoreMock = {
    async getUser(id) { const u = users.get(id); return u ? { ...u } : null; },
    async updateUser(id, updates) {
        const u = users.get(id);
        if (!u) return false;
        Object.assign(u, updates);
        return true;
    },
};

// Stands in for the durable config store used when an install has no
// organizations row at all (self-hosted single tenant).
const secrets = new Map();
const configStoreMock = {
    async getSecret(key) { return secrets.has(key) ? secrets.get(key) : null; },
    async setSecretIfAbsent(key, value) {
        // INSERT … ON CONFLICT DO NOTHING: an existing ROW wins, even when its
        // value cannot be decrypted and getSecret therefore answers null.
        if (!configRows.has(key)) { configRows.add(key); secrets.set(key, value); }
        return secrets.has(key) ? secrets.get(key) : null;
    },
};

const AUTH_DIR = __dirname;
require.cache[require.resolve(path.join(AUTH_DIR, '..', 'db'))] = {
    id: 'db-mock', filename: 'db-mock', loaded: true, exports: dbMock,
};
require.cache[require.resolve(path.join(AUTH_DIR, '..', 'stores', 'userStore'))] = {
    id: 'us-mock', filename: 'us-mock', loaded: true, exports: userStoreMock,
};
require.cache[require.resolve(path.join(AUTH_DIR, '..', 'stores', 'configStore'))] = {
    id: 'cs-mock', filename: 'cs-mock', loaded: true, exports: configStoreMock,
};

const escrow = require('./orgEscrow');

function reset() {
    orgs.clear();
    users.clear();
    secrets.clear();
    configRows.clear();
    escrow.invalidateOrgKeyCache();
}

test('mints an org root key on first use and persists it wrapped', async () => {
    reset();
    seedOrg('org-a');
    const key = await escrow.getOrgRootKey('org-a');
    assert.strictEqual(key.length, 32);
    const stored = orgs.get('org-a').org_root_key;
    assert.ok(stored, 'root key should be persisted');
    assert.ok(!stored.includes(key.toString('base64')), 'must be stored wrapped, never in the clear');
});

test('returns the same root key on subsequent calls', async () => {
    reset();
    seedOrg('org-a');
    const first = await escrow.getOrgRootKey('org-a');
    const firstCopy = Buffer.from(first);
    escrow.invalidateOrgKeyCache();          // force a re-read from "disk"
    const second = await escrow.getOrgRootKey('org-a');
    assert.ok(firstCopy.equals(second), 'root key must be stable across reads');
});

test('different orgs get different root keys', async () => {
    reset();
    seedOrg('org-a'); seedOrg('org-b');
    const a = Buffer.from(await escrow.getOrgRootKey('org-a'));
    const b = await escrow.getOrgRootKey('org-b');
    assert.ok(!a.equals(b), 'a leaked org key must not unlock another org');
});

test('org-less callers funnel through the shared sentinel', async () => {
    reset();
    const a = Buffer.from(await escrow.getOrgRootKey(''));
    escrow.invalidateOrgKeyCache();
    const b = await escrow.getOrgRootKey(null);
    assert.ok(a.equals(b), 'empty and null must resolve to the same sentinel org');
});

test('org-less root key is durable across a process restart', async () => {
    // The self-hosted single-tenant case: no organizations row exists, so the
    // key has nowhere to live in that table. Holding it only in memory would
    // mint a different key on every boot and strand every escrowed DEK.
    reset();
    const first = Buffer.from(await escrow.getOrgRootKey(''));
    assert.ok(secrets.size > 0, 'org-less root key must be persisted somewhere durable');

    escrow.invalidateOrgKeyCache();          // simulate a restart (memory gone, storage kept)
    const afterRestart = await escrow.getOrgRootKey('');
    assert.ok(first.equals(afterRestart), 'root key must survive a restart');
});

test('org-less user DEKs still open after a restart', async () => {
    reset();
    users.set('solo', { id: 'solo', organizationId: '' });
    const before = Buffer.from(await escrow.getOrCreateUserDek('solo'));

    escrow.invalidateOrgKeyCache();          // restart
    const after = await escrow.getOrCreateUserDek('solo');
    assert.ok(before.equals(after), 'a single-tenant install must not lose its DEKs on restart');
});

test('a malformed stored root key is refused rather than replaced', async () => {
    reset();
    await escrow.getOrgRootKey('');
    const key = [...secrets.keys()][0];
    secrets.set(key, Buffer.from('too-short').toString('base64'));
    escrow.invalidateOrgKeyCache();
    await assert.rejects(() => escrow.getOrgRootKey(''), /malformed/);
});

test('a stored root key that will not DECRYPT is refused, not silently replaced', async () => {
    // MASTER_ENCRYPTION_KEY changed without scripts/rotate-master-key.js: the
    // `config` row is still there, but configStore.decryptValue fails and
    // getSecret answers null — the same answer it gives for "no row at all".
    // Treating that as absent used to mint a fresh key that INSERT … ON
    // CONFLICT DO NOTHING never persisted, so each boot adopted a different
    // in-memory-only root key and everything escrowed during that boot became
    // unrecoverable. It has to fail as loudly as the organizations-row path.
    reset();
    await escrow.getOrgRootKey('');
    const key = [...secrets.keys()][0];
    secrets.delete(key);            // decryption failure → getSecret() === null
    assert.ok(configRows.has(key), 'the row itself is still there');
    escrow.invalidateOrgKeyCache();

    await assert.rejects(() => escrow.getOrgRootKey(''), /Refusing to mint a replacement/);
    assert.strictEqual(secrets.has(key), false, 'the undecryptable row must not be overwritten either');
});

test('two boots against an undecryptable key never disagree about the key', async () => {
    // The failure mode that made this silent: boot A and boot B each minted a
    // different ephemeral key and both carried on. Whatever happens now, no two
    // calls may return different keys for the same org.
    reset();
    await escrow.getOrgRootKey('');
    const key = [...secrets.keys()][0];
    secrets.delete(key);

    const results = [];
    for (let i = 0; i < 3; i++) {
        escrow.invalidateOrgKeyCache();     // a fresh process
        try { results.push((await escrow.getOrgRootKey('')).toString('base64')); }
        catch (e) { results.push(`ERR:${e.message.slice(0, 40)}`); }
    }
    assert.strictEqual(new Set(results).size, 1, 'every boot must agree');
    assert.match(results[0], /^ERR:/, 'and the agreement must be a refusal, not a shared guess');
});

// ── Root-key bootstrap: the three states a null getSecret() hides ───────────
//
// configStore.getSecret() answers null for THREE situations, and they need
// three different outcomes:
//
//   1. no row yet                     → mint, persist, adopt
//   2. a row whose value will not open → refuse, loudly (fail closed)
//   3. a stale null                    → adopt the winner's key
//
// (3) is not hypothetical: getSecret caches misses for CACHE_TTL_MS (60s), and
// on a cold single-tenant install a peer boot can commit its INSERT between our
// SELECT and our write. Only setSecretIfAbsent can separate (2) from (3) — its
// `INSERT … ON CONFLICT DO NOTHING` read-back hands back the authoritative row,
// ours if we minted it and the peer's if it got there first. A row probe taken
// BEFORE that call sees a row in both cases and cannot choose; an earlier fix
// did exactly that and turned the benign race into a hard boot failure. These
// tests nail down the order: read → set-if-absent → probe only for the message.

const CONFIG_KEY_PREFIX = 'encryption.org_root_key.';

/**
 * Simulate a peer boot whose INSERT commits AFTER our SELECT already answered:
 * getSecret hands back the stale null it read a moment ago, but by the time we
 * reach the write the row is there and holds the peer's perfectly readable key.
 * @returns {{ restore: () => void, configKey: () => string }}
 */
function peerInsertsAfterOurRead(peerKeyB64) {
    const realGetSecret = configStoreMock.getSecret;
    let seenKey = null;
    configStoreMock.getSecret = async (key) => {
        const stale = await realGetSecret(key);
        if (!seenKey && key.startsWith(CONFIG_KEY_PREFIX)) {
            seenKey = key;
            configRows.add(key);            // the peer's INSERT lands…
            secrets.set(key, peerKeyB64);   // …with a value that decrypts fine
        }
        return stale;                       // …but our read already said null
    };
    return {
        restore() { configStoreMock.getSecret = realGetSecret; },
        configKey() { return seenKey; },
    };
}

test('a row appearing between the read and the write converges on the WINNER key', async () => {
    // Two concurrent first-uses on a cold install are ordinary traffic, not a
    // fault. Refusing to boot here is an outage no operator can act on, and
    // minting a second key would strand everything the winner already escrowed.
    // The only correct answer is the winner's key, obtained by letting
    // ON CONFLICT DO NOTHING adjudicate rather than by guessing from a probe.
    reset();
    const peer = require('crypto').randomBytes(32);
    const race = peerInsertsAfterOurRead(peer.toString('base64'));

    let adopted;
    try { adopted = await escrow.getOrgRootKey(''); }
    finally { race.restore(); }

    assert.ok(peer.equals(adopted), 'must converge on the winner key, not a freshly minted one');
    assert.strictEqual(secrets.get(race.configKey()), peer.toString('base64'),
        'ON CONFLICT DO NOTHING: the winner row must survive our write attempt untouched');
});

test('DEKs escrowed by the race winner still open in the boot that lost', async () => {
    // The consequence, spelled out: the losing boot serves the same users. If
    // it throws (the shape the first fix had) or mints its own key (the shape
    // before that), this user's escrowed DEK is unreachable in half the
    // processes handling their requests — an outage or silent data loss
    // depending on which of the two it is.
    reset();
    users.set('solo', { id: 'solo', organizationId: '' });

    // Boot A wins the INSERT and escrows a user DEK under its root key.
    const winnerDek = Buffer.from(await escrow.getOrCreateUserDek('solo'));
    const configKey = [...secrets.keys()][0];
    const winnerKeyB64 = secrets.get(configKey);

    // Boot B's view a moment earlier: its SELECT ran before the peer committed,
    // so it holds a cached miss and the row is not visible to it yet.
    escrow.invalidateOrgKeyCache();
    secrets.delete(configKey);
    configRows.delete(configKey);

    const race = peerInsertsAfterOurRead(winnerKeyB64);
    let reopened;
    try { reopened = await escrow.getOrCreateUserDek('solo'); }
    finally { race.restore(); }

    assert.ok(winnerDek.equals(reopened), 'the same user must get the same DEK from either boot');
});

test('an undecryptable row fails closed on every path that can reach the root key', async () => {
    // Wrong or rotated MASTER_ENCRYPTION_KEY: the row is present and the value
    // is opaque. Every entry point has to refuse, because handing back a
    // heap-only key from ANY of them is the silent data-loss bug — content gets
    // written under a key that dies with the process, while the real key sits
    // in the row waiting for rotate-master-key.js to be run.
    reset();
    await escrow.getOrgRootKey('');
    const configKey = [...secrets.keys()][0];
    secrets.delete(configKey);              // decryption failure → getSecret() === null
    escrow.invalidateOrgKeyCache();

    await assert.rejects(() => escrow.getOrgRootKey(''), /could not be decrypted/);
    await assert.rejects(
        () => escrow.wrapUserDek(require('crypto').randomBytes(32), '', 'u1'),
        /could not be decrypted/,
        'wrapUserDek must not quietly seal a DEK under an in-memory-only key'
    );
    assert.ok(configRows.has(configKey), 'the unreadable row must still be there…');
    assert.strictEqual(secrets.has(configKey), false, '…and must not have been overwritten');
});

test('a write that does not stick is refused with the OTHER fatal message', async () => {
    // No row afterwards and nothing readable back: the store took the INSERT
    // and lost it. There is nothing to rescue here, but adopting `fresh` anyway
    // would still be a heap-only key, so it fails closed too — with a different
    // message, because the operator's next step is different. This is the whole
    // job the row probe is allowed to do: pick which FATAL line to print. It
    // must never be what decides *whether* to throw.
    reset();
    const realSet = configStoreMock.setSecretIfAbsent;
    configStoreMock.setSecretIfAbsent = async () => null;
    try {
        await assert.rejects(() => escrow.getOrgRootKey(''), /could not be read back/);
    } finally {
        configStoreMock.setSecretIfAbsent = realSet;
    }
    assert.strictEqual(secrets.size, 0, 'and no key may be handed out from memory');
});

test('a readable stored key is adopted unchanged, without attempting a write', async () => {
    // "Adopt if readable" comes FIRST and is terminal. A healthy install must
    // never reach the mint-and-write step: generating key material it does not
    // need is at best waste, and at worst one more chance to race itself.
    reset();
    const first = Buffer.from(await escrow.getOrgRootKey(''));
    const configKey = [...secrets.keys()][0];

    let writes = 0;
    const realSet = configStoreMock.setSecretIfAbsent;
    configStoreMock.setSecretIfAbsent = async (k, v) => { writes++; return realSet(k, v); };
    escrow.invalidateOrgKeyCache();          // force a re-read from "disk"
    let again;
    try { again = await escrow.getOrgRootKey(''); }
    finally { configStoreMock.setSecretIfAbsent = realSet; }

    assert.ok(first.equals(again), 'the stored key must come back byte-for-byte');
    assert.strictEqual(writes, 0, 'no set-if-absent may run once getSecret has answered');
    assert.strictEqual(secrets.get(configKey), first.toString('base64'), 'and the row stays as it was');
});

test('the config mock keeps "row exists" separate from "value decrypts"', async () => {
    // A guard rail for this file rather than for orgEscrow. The bug under test
    // only exists in the state where a row is present AND getSecret answers
    // null. A mock that returns the value whenever the key is in the decrypted
    // map cannot represent that state at all, and every assertion above
    // quietly stops testing anything — which is exactly how this mock was
    // written before, and why the bug survived a green suite.
    reset();
    const key = `${CONFIG_KEY_PREFIX}mock-shape-check`;
    configRows.add(key);                    // row present, value opaque
    assert.strictEqual(await configStoreMock.getSecret(key), null,
        'an undecryptable row must read as null, same as no row at all');
    assert.strictEqual(await configStoreMock.setSecretIfAbsent(key, 'replacement'), null,
        'ON CONFLICT DO NOTHING must neither overwrite nor invent a readable value');
    assert.strictEqual(secrets.has(key), false, 'the stored row is left exactly as it was');
});

test('a user with an escrow envelope fails loudly rather than getting a new key', async () => {
    reset();
    users.set('solo', { id: 'solo', organizationId: '' });
    await escrow.getOrCreateUserDek('solo');
    const key = [...secrets.keys()][0];
    secrets.delete(key);                    // master key changed
    escrow.invalidateOrgKeyCache();

    await assert.rejects(() => escrow.getOrCreateUserDek('solo'), /Refusing to mint a replacement/);
});

test('wraps and unwraps a user DEK', async () => {
    reset();
    seedOrg('org-a');
    const crypto = require('crypto');
    const dek = crypto.randomBytes(32);
    const sealed = await escrow.wrapUserDek(dek, 'org-a', 'user-1');
    assert.ok(!sealed.includes(dek.toString('base64')), 'DEK must not appear in the envelope');
    const out = await escrow.unwrapUserDek(sealed, 'org-a', 'user-1');
    assert.ok(dek.equals(out), 'round-trip must return the same DEK');
});

test('a DEK wrapped for one user cannot be opened as another (AAD binding)', async () => {
    reset();
    seedOrg('org-a');
    const dek = require('crypto').randomBytes(32);
    const sealed = await escrow.wrapUserDek(dek, 'org-a', 'user-1');
    assert.strictEqual(await escrow.unwrapUserDek(sealed, 'org-a', 'user-2'), null);
});

test('a DEK wrapped in one org cannot be opened in another (cross-tenant)', async () => {
    reset();
    seedOrg('org-a'); seedOrg('org-b');
    const dek = require('crypto').randomBytes(32);
    const sealed = await escrow.wrapUserDek(dek, 'org-a', 'user-1');
    assert.strictEqual(await escrow.unwrapUserDek(sealed, 'org-b', 'user-1'), null);
});

test('getOrCreateUserDek mints once, then returns the same DEK — no password needed', async () => {
    reset();
    seedOrg('org-a');
    users.set('user-1', { id: 'user-1', organizationId: 'org-a' });

    const first = await escrow.getOrCreateUserDek('user-1');
    assert.strictEqual(first.length, 32);
    assert.ok(users.get('user-1').orgWrappedDEK, 'escrow envelope should be persisted');

    const second = await escrow.getOrCreateUserDek('user-1');
    assert.ok(first.equals(second), 'the escrowed DEK must be stable across calls');
});

test('an admin password reset does not change the escrowed DEK', async () => {
    reset();
    seedOrg('org-a');
    users.set('user-1', { id: 'user-1', organizationId: 'org-a', passwordHash: 'old' });
    const before = await escrow.getOrCreateUserDek('user-1');

    // Exactly what an admin reset does to the row today.
    await userStoreMock.updateUser('user-1', { passwordHash: 'new', wrappedDEK: null, kekSalt: null });

    const after = await escrow.getOrCreateUserDek('user-1');
    assert.ok(before.equals(after), 'the user keeps access to their data after an admin reset');
});

test('refuses to mint a replacement when an existing escrow envelope will not open', async () => {
    reset();
    seedOrg('org-a');
    users.set('user-1', { id: 'user-1', organizationId: 'org-a', orgWrappedDEK: '{"iv":"AAAA","authTag":"AAAA","data":"AAAA"}' });
    await assert.rejects(
        () => escrow.getOrCreateUserDek('user-1'),
        /Refusing to mint a replacement/,
        'silently minting a new DEK would orphan every row encrypted under the old one'
    );
});

test('unknown user yields null rather than throwing', async () => {
    reset();
    seedOrg('org-a');
    assert.strictEqual(await escrow.getOrCreateUserDek('nobody'), null);
});

// ── Rotation ────────────────────────────────────────────────────────────────

test('rotation rewraps every member and keeps their DEKs identical', async () => {
    reset();
    seedOrg('org-a');
    users.set('u1', { id: 'u1', organizationId: 'org-a' });
    users.set('u2', { id: 'u2', organizationId: 'org-a' });

    const d1 = Buffer.from(await escrow.getOrCreateUserDek('u1'));
    const d2 = Buffer.from(await escrow.getOrCreateUserDek('u2'));
    const sealedBefore = users.get('u1').orgWrappedDEK;

    const res = await escrow.rotateOrgRootKey('org-a');
    assert.strictEqual(res.rotated, 2);
    assert.strictEqual(res.skipped, 0);
    assert.notStrictEqual(users.get('u1').orgWrappedDEK, sealedBefore, 'envelope should be rewrapped');
    assert.strictEqual(orgs.get('org-a').org_key_version, 2, 'key version should advance');

    // The DEKs — and therefore all encrypted content — are unchanged.
    assert.ok(d1.equals(await escrow.getOrCreateUserDek('u1')));
    assert.ok(d2.equals(await escrow.getOrCreateUserDek('u2')));
});

test('rotation aborts without swapping the key if any member cannot be rewrapped', async () => {
    reset();
    seedOrg('org-a');
    users.set('u1', { id: 'u1', organizationId: 'org-a' });
    await escrow.getOrCreateUserDek('u1');
    const goodEnvelope = users.get('u1').orgWrappedDEK;
    const versionBefore = orgs.get('org-a').org_key_version;

    users.set('u2', { id: 'u2', organizationId: 'org-a', orgWrappedDEK: '{"iv":"AA","authTag":"AA","data":"AA"}' });

    await assert.rejects(() => escrow.rotateOrgRootKey('org-a'), /Aborting rotation/);
    assert.strictEqual(users.get('u1').orgWrappedDEK, goodEnvelope, 'healthy member untouched');
    assert.strictEqual(orgs.get('org-a').org_key_version, versionBefore, 'key version must not advance');
    assert.ok(await escrow.getOrCreateUserDek('u1'), 'u1 still opens after the aborted rotation');
});
