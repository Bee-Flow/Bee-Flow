// @typecheck
/**
 * Org key escrow — the "managed" encryption tier.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * In the zero-knowledge tier a user's DEK is wrapped only by a secret the
 * server never sees. That is the strongest posture, and it has two costs the
 * product cannot actually pay everywhere:
 *
 *   1. An admin cannot reset a password without destroying the user's data.
 *      Today /auth/reset-password does not even try — it rewrites the password
 *      hash and leaves the DEK wrapped under the old one, so the user resets
 *      their password and is then locked out of their own history.
 *   2. Background work has no user present. Automations, scheduled agents and
 *      compaction run at 3am with no session, so they either scrape a stored
 *      session for a key or silently write plaintext.
 *
 * The managed tier fixes both by wrapping each user's DEK a second time under
 * a per-org root key (ORK) that the server can reach.
 *
 * ── Key hierarchy ───────────────────────────────────────────────────────────
 *
 *   MASTER_ENCRYPTION_KEY          env / K8s secret — never in the database
 *      │ HMAC-SHA256 (orgVault.orgVaultKey)
 *      ▼
 *   Org vault KEK  ──wraps──►  Org Root Key (random 32B, per org)
 *                                stored in organizations.org_root_key
 *      │ AES-256-GCM, AAD "dek-org:{orgId}:{userId}"
 *      ▼
 *   User DEK (random 32B)  ──►  stored in users."orgWrappedDEK"
 *
 * The ORK is random and wrapped rather than derived directly from the master.
 * orgVault derives its key straight from MASTER_ENCRYPTION_KEY, which means
 * rotating the master forces re-encrypting every row that used it. Here a
 * master rotation only has to rewrap ONE row per org, and an org can later
 * bring its own key (KMS/BYOK) by swapping the wrapping step alone.
 *
 * ── What this protects against, stated honestly ─────────────────────────────
 *
 * A stolen database, backup, disk or read replica yields nothing: the master
 * key lives in the orchestrator's secret store, not in Postgres. It does NOT
 * protect against the operator of the server, who has the master key in their
 * environment. This tier is not zero-knowledge and must never be described as
 * such.
 *
 * IMPORTANT for rotation: `scripts/rotate-master-key.js` keeps an inventory of
 * every envelope derived from MASTER_ENCRYPTION_KEY. organizations.org_root_key
 * belongs in it — omitting an envelope from that inventory is a silent
 * data-loss event, as the script's own header warns.
 */

const crypto = require('crypto');

const orgVault = require('../stores/orgVault');
const { wrapDEK, unwrapDEK, secureClear } = require('./encryption');
const { resolveOrgId } = require('../stores/integrationConnectionStore');

const DEK_LENGTH = 32;

/** AAD binding a wrapped DEK to one (org, user) pair — blocks cross-tenant replay. */
function dekAad(orgId, userId) {
    return `dek-org:${orgId}:${userId}`;
}

// ── ORK cache ───────────────────────────────────────────────────────────────
// Bounded and expiring. auth/connectorJwt.js caches derived keys forever in an
// unbounded Map ("we cache forever"); that is a leak and long-lived key
// material in heap, and it is not a pattern to copy.
const _orkCache = new Map(); // orgId -> { at, key: Buffer }
const ORK_TTL_MS = 5 * 60_000;
const ORK_CACHE_MAX = 200;

function _cacheGet(orgId) {
    const hit = _orkCache.get(orgId);
    if (!hit) return null;
    if (Date.now() - hit.at > ORK_TTL_MS) {
        _orkCache.delete(orgId);
        secureClear(hit.key);
        return null;
    }
    return hit.key;
}

function _cacheSet(orgId, key) {
    if (_orkCache.size >= ORK_CACHE_MAX) {
        const oldest = _orkCache.keys().next().value;
        if (oldest !== undefined) {
            const ev = _orkCache.get(oldest);
            _orkCache.delete(oldest);
            if (ev) secureClear(ev.key);
        }
    }
    _orkCache.set(orgId, { at: Date.now(), key });
}

/**
 * Drop cached org root keys. Call after rotation.
 * @param {string} [orgId] omit to clear every org
 */
function invalidateOrgKeyCache(orgId) {
    if (orgId === undefined) {
        for (const [, v] of _orkCache) secureClear(v.key);
        _orkCache.clear();
        return;
    }
    const id = resolveOrgId(orgId);
    const hit = _orkCache.get(id);
    if (hit) secureClear(hit.key);
    _orkCache.delete(id);
}

/**
 * Load the org root key, creating and persisting one on first use.
 *
 * Org-less users (self-hosted single tenant, the built-in `admin`) funnel
 * through the SAME `resolveOrgId` sentinel the connection store uses. A
 * divergent sentinel would derive a different key for every org-less row —
 * stores/keyRotationEnvelopes.test.js exists precisely to pin that down.
 *
 * @param {string|null} rawOrgId
 * @returns {Promise<Buffer>} 32-byte root key
 */
async function getOrgRootKey(rawOrgId) {
    const orgId = resolveOrgId(rawOrgId);
    const cached = _cacheGet(orgId);
    if (cached) return cached;

    const { getOne, run } = require('../db');

    const row = await getOne('SELECT "org_root_key" FROM organizations WHERE id = $1', [orgId]);

    if (row && row.org_root_key) {
        const raw = orgVault.decrypt(row.org_root_key, orgId);
        if (!raw) {
            // The envelope exists but will not open. Generating a replacement
            // here would orphan every DEK already wrapped under the real key,
            // so refuse loudly instead. Usual cause: MASTER_ENCRYPTION_KEY was
            // rotated without running scripts/rotate-master-key.js.
            throw new Error(
                `[OrgEscrow] org_root_key for ${orgId} could not be decrypted. ` +
                'Refusing to mint a replacement — that would strand every wrapped DEK in this org. ' +
                'Check MASTER_ENCRYPTION_KEY and scripts/rotate-master-key.js.'
            );
        }
        const key = Buffer.from(raw, 'base64');
        _cacheSet(orgId, key);
        return key;
    }

    // First use for this org — mint one.
    const key = crypto.randomBytes(32);
    const sealed = orgVault.encrypt(key.toString('base64'), orgId);

    // Only write where none exists, so two concurrent requests cannot clobber
    // each other's key. If we lose the race we re-read the winner's value.
    const res = await run(
        `UPDATE organizations SET "org_root_key" = $1, "org_key_version" = COALESCE("org_key_version", 1)
         WHERE id = $2 AND "org_root_key" IS NULL`,
        [sealed, orgId]
    );
    const wrote = res?.rowCount ?? /** @type {any} */ (res)?.changes ?? 0;
    if (wrote) {
        _cacheSet(orgId, key);
        return key;
    }

    // Lost a race against a concurrent writer? Re-read and use the winner.
    const again = await getOne('SELECT "org_root_key" FROM organizations WHERE id = $1', [orgId]);
    if (again && again.org_root_key) {
        secureClear(key);
        const raw = orgVault.decrypt(again.org_root_key, orgId);
        if (!raw) throw new Error(`[OrgEscrow] org_root_key for ${orgId} could not be decrypted after a concurrent write.`);
        const winner = Buffer.from(raw, 'base64');
        _cacheSet(orgId, winner);
        return winner;
    }

    // No organizations row at all. This is the normal case for a self-hosted
    // single-tenant install, where users carry an empty organizationId and
    // everything funnels through the DEFAULT_ORG_SENTINEL.
    //
    // Holding the key only in memory here would be a data-loss bug: the
    // process would mint a DIFFERENT root key on every restart and every
    // previously escrowed DEK would stop opening. Persist it in configStore
    // instead — durable, already master-key encrypted under the `config-v1`
    // envelope that scripts/rotate-master-key.js knows about, and its
    // set-if-absent is atomic so concurrent boots converge on one winner.
    secureClear(key);
    return await _rootKeyFromConfigStore(orgId);
}

const CONFIG_KEY_PREFIX = 'encryption.org_root_key.';

/**
 * Does a `config` row exist for this key, whatever its contents?
 *
 * Only meaningful AFTER setSecretIfAbsent has already failed to hand back a
 * readable value: at that point a row that is still there says "the stored key
 * cannot be decrypted", and no row says "the write did not stick". Used on its
 * own, before the set-if-absent, this probe cannot tell an undecryptable row
 * from a peer's INSERT that landed a moment ago — see _rootKeyFromConfigStore.
 */
async function _configRowExists(configKey) {
    const { getOne } = require('../db');
    const row = await getOne('SELECT 1 AS present FROM config WHERE key = $1', [configKey]);
    return !!row;
}

/** Decode a stored base64 root key, validate its length, cache and return it. */
function _adoptStoredRootKey(orgId, b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 32) {
        throw new Error(`[OrgEscrow] Stored root key for '${orgId}' is malformed (${buf.length} bytes). Refusing to replace it.`);
    }
    _cacheSet(orgId, buf);
    return buf;
}

async function _rootKeyFromConfigStore(orgId) {
    const configStore = require('../stores/configStore');
    const configKey = `${CONFIG_KEY_PREFIX}${orgId}`;

    const existing = await configStore.getSecret(configKey);
    if (existing) return _adoptStoredRootKey(orgId, existing);

    // A null from getSecret() conflates THREE states, not two: no row yet; a
    // row whose value will not decrypt; and a stale `null` — getSecret caches
    // misses for CACHE_TTL_MS (60s), and on a cold single-tenant install a
    // concurrent first-use may have committed its INSERT since we looked.
    //
    // setSecretIfAbsent separates them without ever putting the stored value at
    // risk: `INSERT … ON CONFLICT DO NOTHING` cannot overwrite an existing row,
    // and its read-back invalidates the local cache first, so whatever comes
    // back is the authoritative winner — ours if we minted it, the other boot's
    // if it beat us to it. That is the convergence the pre-fix code had, and
    // probing the row BEFORE this call took it away: a benign race and a stale
    // cached null both looked exactly like an undecryptable row and threw.
    const fresh = crypto.randomBytes(32).toString('base64');
    const winner = await configStore.setSecretIfAbsent(configKey, fresh);
    if (winner) return _adoptStoredRootKey(orgId, winner);

    // Nothing readable came back, so the row — if any — is genuinely broken.
    // Falling back to `fresh` here (what the original code did) adopts a root
    // key that exists only in this process's heap: every DEK and project key
    // wrapped under it during that boot becomes unrecoverable at the next
    // restart, silently, with a different key each time. Refuse instead,
    // exactly as the organizations-row path does at the top of getOrgRootKey.
    // The row probe now only picks which of the two fatal messages to print.
    if (await _configRowExists(configKey)) {
        throw new Error(
            `[OrgEscrow] org_root_key for '${orgId}' is stored in config but could not be decrypted. ` +
            'Refusing to mint a replacement — that would strand every wrapped DEK in this install. ' +
            'Check MASTER_ENCRYPTION_KEY and scripts/rotate-master-key.js.'
        );
    }
    throw new Error(
        `[OrgEscrow] Failed to persist a root key for '${orgId}' — the value could not be read back. ` +
        'Refusing to continue with an in-memory-only key: anything escrowed under it would be lost on restart.'
    );
}

/**
 * Wrap a user's DEK under their org's root key.
 * @returns {Promise<string>} JSON envelope, storable in users."orgWrappedDEK"
 */
async function wrapUserDek(dek, rawOrgId, userId) {
    const orgId = resolveOrgId(rawOrgId);
    const ork = await getOrgRootKey(orgId);
    return JSON.stringify(wrapDEK(dek, ork, dekAad(orgId, userId)));
}

/**
 * Unwrap a user's escrowed DEK.
 * @returns {Promise<Buffer|null>} the DEK, or null if it cannot be opened
 */
async function unwrapUserDek(stored, rawOrgId, userId) {
    if (!stored) return null;
    const orgId = resolveOrgId(rawOrgId);
    let envelope;
    try {
        envelope = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch (_) {
        return null;
    }
    const ork = await getOrgRootKey(orgId);
    return unwrapDEK(envelope, ork, dekAad(orgId, userId));
}

/**
 * The escrow entry point: get this user's DEK, minting and persisting one on
 * first use. No user secret required — that is the point of the tier, and what
 * lets an admin reset a password, and a 3am automation read the same data,
 * without anyone losing anything.
 *
 * @param {string} userId
 * @param {string|null} [orgIdHint] avoids a user lookup when the caller knows it
 * @returns {Promise<Buffer|null>} DEK, or null if the user does not exist
 */
async function getOrCreateUserDek(userId, orgIdHint = undefined, { seedDek = null } = {}) {
    if (!userId) return null;
    const userStore = require('../stores/userStore');
    const user = await userStore.getUser(userId);
    if (!user) return null;

    const orgId = resolveOrgId(orgIdHint !== undefined ? orgIdHint : user.organizationId);

    if (user.orgWrappedDEK) {
        const dek = await unwrapUserDek(user.orgWrappedDEK, orgId, userId);
        if (dek) return dek;
        // Present but unopenable. Minting a fresh DEK would silently orphan
        // every row already encrypted under the old one, so surface it.
        throw new Error(
            `[OrgEscrow] orgWrappedDEK for user ${userId} could not be opened. ` +
            'Refusing to mint a replacement — existing encrypted rows would become unreadable.'
        );
    }

    // First escrow for this user. Prefer ADOPTING their login-derived DEK over
    // minting a random one.
    //
    // This used to always mint fresh, which quietly gave every user two
    // unrelated keys: content written while they were logged in went under the
    // login DEK (resolveCrypto preferred the session key), while every keyless
    // caller read under this one. The reads then threw FieldDecryptError and
    // the tier delivered neither of the two things it exists for. resolveCrypto
    // now treats the escrow as authoritative on `managed`, so seeding it with
    // the key their existing rows were actually written under is what keeps
    // that content readable across the change.
    const dek = _seedBuffer(seedDek) || crypto.randomBytes(DEK_LENGTH);
    const sealed = await wrapUserDek(dek, orgId, userId);

    // Set-if-absent, mirroring getOrgRootKey. Two concurrent requests can both
    // observe a null escrow — and if one carries a session DEK and the other
    // does not, a plain UPDATE would let the random key overwrite the adopted
    // one and strand everything written in between.
    const { run } = require('../db');
    const res = await run(
        'UPDATE users SET "orgWrappedDEK" = $1 WHERE id = $2 AND "orgWrappedDEK" IS NULL',
        [sealed, userId]
    );
    if ((res?.rowCount ?? /** @type {any} */ (res)?.changes ?? 0) > 0) return dek;

    // Lost the race — use the winner's key, never our own.
    secureClear(dek);
    const winner = await userStore.getUser(userId);
    const winnerDek = await unwrapUserDek(winner?.orgWrappedDEK, orgId, userId);
    if (!winnerDek) {
        throw new Error(
            `[OrgEscrow] orgWrappedDEK for user ${userId} could not be opened after a concurrent write.`
        );
    }
    return winnerDek;
}

/** Accept a session DEK as base64 or Buffer; reject anything not 32 bytes. */
function _seedBuffer(seedDek) {
    if (!seedDek) return null;
    try {
        const buf = Buffer.isBuffer(seedDek) ? seedDek : Buffer.from(String(seedDek), 'base64');
        return buf.length === DEK_LENGTH ? buf : null;
    } catch (_) {
        return null;
    }
}

/**
 * Rotate an org's root key: mint a new ORK and rewrap every member's escrowed
 * DEK under it. The DEKs themselves are unchanged, so no user content is
 * re-encrypted and the operation is safe to re-run.
 *
 * ⚠️ That last sentence stopped being universally true once shared project
 * conversations arrived. Their keys are DERIVED from the ORK rather than
 * wrapped by it (see auth/projectEscrow.js), so a rotation silently changes
 * them and orphans the ciphertext. `assertNoSharedConversations` throws rather
 * than let that happen; the eventual fix is to re-encrypt them here.
 *
 * @returns {Promise<{ rotated: number, skipped: number }>}
 */
async function rotateOrgRootKey(rawOrgId) {
    const orgId = resolveOrgId(rawOrgId);
    const { getAll, run } = require('../db');
    const userStore = require('../stores/userStore');

    // Before anything is mutated: a rotation that strands shared conversations
    // is worse than a rotation that does not happen.
    await require('./projectEscrow').assertNoSharedConversations(orgId);

    const oldOrk = await getOrgRootKey(orgId);
    const newOrk = crypto.randomBytes(32);

    const members = await getAll(
        'SELECT id, "orgWrappedDEK" FROM users WHERE "organizationId" = $1 AND "orgWrappedDEK" IS NOT NULL',
        [orgId]
    );

    const rewrapped = [];
    let skipped = 0;
    for (const m of members) {
        let envelope;
        try { envelope = JSON.parse(m.orgWrappedDEK); } catch (_) { skipped++; continue; }
        const dek = unwrapDEK(envelope, oldOrk, dekAad(orgId, m.id));
        if (!dek) { skipped++; continue; }
        rewrapped.push([m.id, JSON.stringify(wrapDEK(dek, newOrk, dekAad(orgId, m.id)))]);
        secureClear(dek);
    }

    // The org's transcript DEK is WRAPPED by the ORK, so it rewraps like a
    // member DEK rather than blocking rotation the way projectEscrow's derived
    // key does. It throws if it cannot be rewrapped, and it throws BEFORE the
    // ORK is swapped below — rotating past it would strand every transcription
    // in the organisation.
    let rewrappedTranscriptDek = null;
    try {
        rewrappedTranscriptDek = await require('./transcriptEscrow').rewrapForRotation(orgId, oldOrk, newOrk);
    } catch (err) {
        secureClear(newOrk);
        throw err;
    }

    if (skipped) {
        // Never swap the ORK while some member's DEK could not be rewrapped —
        // they would be permanently locked out of their own content.
        secureClear(newOrk);
        throw new Error(
            `[OrgEscrow] Aborting rotation for ${orgId}: ${skipped} member DEK(s) could not be rewrapped. ` +
            'Rotating anyway would strand their encrypted data.'
        );
    }

    await run(
        `UPDATE organizations SET "org_root_key" = $1, "org_key_version" = COALESCE("org_key_version", 1) + 1 WHERE id = $2`,
        [orgVault.encrypt(newOrk.toString('base64'), orgId), orgId]
    );
    for (const [id, sealed] of rewrapped) {
        await userStore.updateUser(id, { orgWrappedDEK: sealed });
    }
    if (rewrappedTranscriptDek) {
        const { DEK_COLUMN } = require('./transcriptEscrow');
        await run(`UPDATE organizations SET "${DEK_COLUMN}" = $1 WHERE id = $2`, [rewrappedTranscriptDek, orgId]);
    }

    invalidateOrgKeyCache(orgId);
    // The transcript DEK is unchanged in value but re-enveloped, and any cached
    // copy was unwrapped under the old ORK.
    require('./transcriptEscrow').invalidateTranscriptKeyCache(orgId);
    // Project keys are derived from the ORK, so every cached one is now stale.
    require('./projectEscrow').invalidateProjectKeyCache(orgId);
    secureClear(newOrk);
    return { rotated: rewrapped.length, skipped: 0 };
}

module.exports = {
    dekAad,
    getOrgRootKey,
    wrapUserDek,
    unwrapUserDek,
    getOrCreateUserDek,
    rotateOrgRootKey,
    invalidateOrgKeyCache,
};
