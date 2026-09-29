#!/usr/bin/env node
/**
 * MASTER_ENCRYPTION_KEY rotation utility.
 *
 * Rotates the master key used by configStore (and any other helper that
 * derives from MASTER_ENCRYPTION_KEY) without downtime. Operationally:
 *
 *   1. Generate a new key:
 *        openssl rand -hex 32
 *      Stage it as MASTER_ENCRYPTION_KEY_NEW in the orchestrator's secret
 *      store. DO NOT replace MASTER_ENCRYPTION_KEY yet.
 *
 *   2. Deploy a build of the server that has BOTH env vars set. Restart.
 *      The server still uses MASTER_ENCRYPTION_KEY for all reads.
 *
 *   3. Run this script on one app node:
 *        MASTER_ENCRYPTION_KEY=<old>  \
 *        MASTER_ENCRYPTION_KEY_NEW=<new>  \
 *        node scripts/rotate-master-key.js
 *      It decrypts every config row with the OLD key and re-encrypts with
 *      the NEW key. Idempotent: rows that fail to decrypt with OLD are
 *      tested against NEW and skipped if they're already rotated. Plain-
 *      text rows are seeded with the NEW key (the L5 fixture filter
 *      should have re-encrypted them long before this point).
 *
 *   4. Promote MASTER_ENCRYPTION_KEY_NEW to MASTER_ENCRYPTION_KEY in the
 *      secret store. Drop the _NEW alias on the next deploy. The cluster
 *      now reads with the new key.
 *
 *   5. Per-org derived keys are computed deterministically from
 *      MASTER_ENCRYPTION_KEY + orgId, so they change with the master. Every
 *      table sealed that way is rotated below — see the envelope inventory.
 *
 *   Envelope inventory (all of these MUST be rotated or the key change is a
 *   silent data-loss event — decrypt just returns null):
 *
 *     'config-v1'         configStore     — config.value, users.mfa_secret,
 *                                           webpage_public_shares.token_cipher
 *     'routine-vault-v1'  orgVault        — integration_connections.secret,
 *                                           routine_credentials.access_token,
 *                                           routine_credentials.refresh_token,
 *                                           organizations.org_root_key,
 *                                           voiceprints.voiceprint_enc
 *     'appcred-v1'        userStore       — users."appPassword"
 *
 *   organizations.org_root_key is the one on this list that is not a
 *   credential. It is the Org Root Key that WRAPS every user DEK in the org
 *   (auth/orgEscrow.js), so missing it does not lose one integration — it
 *   loses the org's entire encrypted history at once, for everyone, with no
 *   way back. orgEscrow's own header has said it belongs in this inventory
 *   since it was written; it was never added. voiceprints.voiceprint_enc is
 *   biometric data under GDPR Art. 9, and a lost template cannot be re-derived
 *   from anything the product still holds — the person has to re-enrol.
 *
 *   NOT on this list, and deliberately so: organizations.org_transcript_dek
 *   (auth/transcriptEscrow.js). It is wrapped by the ORG ROOT KEY, not by the
 *   master, and a master rotation re-seals the org_root_key ENVELOPE while
 *   leaving the ORK bytes themselves unchanged — so every ORK-wrapped key keeps
 *   opening. Adding it to a master-rotation pass would be an attempt to rewrap
 *   it under a key that never wrapped it. The ORK rotation is a different
 *   operation (orgEscrow.rotateOrgRootKey) and rewraps it there.
 *   keyRotationEnvelopes.test.js pins this invariant, because it is exactly the
 *   kind of thing that breaks silently.
 *
 *   Adding an orgVault-sealed column anywhere means adding it HERE and in
 *   server/stores/keyRotationEnvelopes.test.js. `grep -rn 'orgVault\.\(encrypt\|
 *   decrypt\)' server --include=*.js` lists every call site; the inventory above
 *   is complete against that sweep as of this commit.
 *
 *   The orgVault + appcred passes were added after a rotation was found to
 *   brick every integration credential, OAuth refresh token and Nextcloud app
 *   password: they use different envelope tags and key derivations, so the
 *   original config-v1-only sweep skipped them entirely and left the rows
 *   sealed under a key that no longer existed.
 *
 *   NOTE: import-store envelopes (if any deployment uses them) are not yet
 *   covered — check server/stores/importStore.js before promoting NEW.
 *   secretBox (support-inbox) derives from SESSION_SECRET,
 *   not the master, so it is deliberately out of scope here.
 *
 * Don't run this on more than one node at a time — the UPDATE batches
 * are serialised but a concurrent run on a different node would re-rotate
 * rows the first node already touched and waste cycles.
 */

// Required lazily inside main() so importing this file for its envelope
// helpers (see the test) never opens a database pool.
const crypto = require('crypto');

const ORG_KEY_PREFIX_RE = /^org_([^_]+)_/;

function inferOrgIdFromKey(key) {
    const m = key && key.match(ORG_KEY_PREFIX_RE);
    return m ? m[1] : null;
}

function deriveKey(master, orgId = null) {
    const info = orgId
        ? `beeflow:config-secrets:v1:${orgId}`
        : 'beeflow:config-secrets:v1';
    return crypto.createHmac('sha256', master).update(info).digest();
}

// ── Sibling envelope schemes ────────────────────────────────────────
// Must stay byte-identical to their source modules, or a rotation writes
// ciphertext the app can't read. Pinned by rotate-master-key.test.js.

// server/stores/orgVault.js — integration_connections + routine_credentials.
const ORG_VAULT_TAG = 'routine-vault-v1';
const DEFAULT_ORG_SENTINEL = '__default_org__';
function deriveOrgVaultKey(master, orgId) {
    return crypto.createHmac('sha256', master)
        .update(`beeflow:routine-vault:v1:org:${orgId}`)
        .digest();
}

// server/stores/userStore.js — users."appPassword".
const APP_PWD_TAG = 'appcred-v1';
function deriveAppPwdKey(master) {
    return crypto.createHmac('sha256', master).update('beeflow:app-password:v1').digest();
}
// Pre-domain-separation derivation, kept so v1 rows rotate straight to v2.
function deriveLegacyAppPwdKey(master) {
    return crypto.createHash('sha256').update(master).digest();
}

function encryptTagged(plaintext, key, tag) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({
        _encrypted: tag,
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        data: enc.toString('hex'),
    });
}

function tryDecrypt(envelope, key) {
    try {
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (_) {
        return null;
    }
}

function encrypt(plaintext, key, orgId = null) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const env = {
        _encrypted: 'config-v1',
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        data: enc.toString('hex'),
    };
    if (orgId) env.keyContext = orgId;
    return JSON.stringify(env);
}

// 32-bit advisory-lock key — `crc32('beeflow:master-key-rotation')`. Any
// constant will do; what matters is that every node uses the same one so
// a concurrent script invocation on a sibling fails fast instead of
// re-rotating rows the first node already touched.
const ROTATION_LOCK_KEY = 0x42664D52; // 'BfMR'

async function main() {
    const { pool } = require('../server/db');
    const oldMaster = process.env.MASTER_ENCRYPTION_KEY;
    const newMaster = process.env.MASTER_ENCRYPTION_KEY_NEW;
    if (!oldMaster || !newMaster) {
        console.error('Both MASTER_ENCRYPTION_KEY and MASTER_ENCRYPTION_KEY_NEW must be set.');
        process.exit(1);
    }
    if (oldMaster === newMaster) {
        console.error('MASTER_ENCRYPTION_KEY and MASTER_ENCRYPTION_KEY_NEW are identical — nothing to rotate.');
        process.exit(1);
    }

    // Acquire a session-scoped advisory lock so a concurrent invocation on
    // another node aborts instead of fighting us for the same rows. The
    // lock is released automatically when this script's PG session ends
    // (pool.end()), so there's no need to explicitly unlock.
    const client = await pool.connect();
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [ROTATION_LOCK_KEY]);
    if (!lockRows?.[0]?.got) {
        console.error('[rotate] another rotation appears to be running (pg_try_advisory_lock returned false). Aborting.');
        client.release();
        await pool.end();
        process.exit(3);
    }
    console.log('[rotate] acquired advisory lock');

    const { rows } = await client.query('SELECT key, value FROM config');
    let rotated = 0;
    let alreadyNew = 0;
    let plaintext = 0;
    let unreadable = 0;
    for (const row of rows) {
        if (!row.value) continue;
        let envelope;
        try { envelope = JSON.parse(row.value); } catch (_) { envelope = null; }

        // Pick the right HKDF context for both decrypt and the re-seal.
        // envelope.keyContext is authoritative when present (set by post-M3
        // writes); fall back to inferring from the key name for legacy rows
        // that pre-date the field.
        const envCtx = envelope && typeof envelope.keyContext === 'string' ? envelope.keyContext : null;
        const inferredCtx = inferOrgIdFromKey(row.key);
        const targetCtx = envCtx || inferredCtx || null;

        const oldKeyDerived = deriveKey(oldMaster, targetCtx);
        const newKeyDerived = deriveKey(newMaster, targetCtx);

        if (envelope && envelope._encrypted === 'config-v1') {
            const oldPt = tryDecrypt(envelope, oldKeyDerived);
            if (oldPt !== null) {
                const reSealed = encrypt(oldPt, newKeyDerived, targetCtx);
                await client.query('UPDATE config SET value = $1, updated_at = NOW() WHERE key = $2', [reSealed, row.key]);
                rotated++;
                continue;
            }
            // OLD key didn't work — maybe already rotated to NEW.
            const newPt = tryDecrypt(envelope, newKeyDerived);
            if (newPt !== null) {
                alreadyNew++;
                continue;
            }
            // Last resort: try the legacy single-tenant key (older rows that
            // weren't yet migrated under the per-org context).
            const oldKeyLegacy = deriveKey(oldMaster, null);
            const legacyPt = tryDecrypt(envelope, oldKeyLegacy);
            if (legacyPt !== null) {
                const reSealed = encrypt(legacyPt, newKeyDerived, targetCtx);
                await client.query('UPDATE config SET value = $1, updated_at = NOW() WHERE key = $2', [reSealed, row.key]);
                rotated++;
                continue;
            }
            console.error(`[rotate] UNREADABLE key="${row.key}" — neither OLD nor NEW master can decrypt it.`);
            unreadable++;
        } else {
            // Plaintext (legacy) row. Seal with NEW key + the right context.
            const reSealed = encrypt(String(row.value), newKeyDerived, targetCtx);
            await client.query('UPDATE config SET value = $1, updated_at = NOW() WHERE key = $2', [reSealed, row.key]);
            plaintext++;
        }
    }
    console.log(`[rotate] config done — rotated=${rotated} already_new=${alreadyNew} plaintext_sealed=${plaintext} unreadable=${unreadable}`);

    // ── Sibling tables sealed with the DEFAULT-context configStore envelope ──
    // These use configStore.encryptValue/decryptValue (no org context), so the
    // derived key is deriveKey(master, null). Rows that decrypt with neither
    // master were broken BEFORE this rotation (they don't block promotion, but
    // for mfa_secret they mean the user needs the admin 2FA-reset).
    async function rotateEnvelopeColumn({ table, idCol, valueCol, label, quoteId = false }) {
        const { rows: colRows } = await client.query(
            `SELECT ${idCol} AS id, ${valueCol} AS value FROM ${table} WHERE ${valueCol} IS NOT NULL AND ${valueCol} <> ''`
        );
        let colRotated = 0, colAlreadyNew = 0, colUnreadable = 0, colPlain = 0;
        for (const row of colRows) {
            let envelope;
            try { envelope = JSON.parse(row.value); } catch (_) { envelope = null; }
            // Honour a per-org keyContext when the envelope carries one —
            // e.g. webpage share tokens created for org-owned pages are
            // sealed under the org-derived key, not the default context.
            const ctx = envelope && typeof envelope.keyContext === 'string' ? envelope.keyContext : null;
            const keyOld = deriveKey(oldMaster, ctx);
            const keyNew = deriveKey(newMaster, ctx);
            if (envelope && envelope._encrypted === 'config-v1') {
                const oldPt = tryDecrypt(envelope, keyOld);
                if (oldPt !== null) {
                    await client.query(`UPDATE ${table} SET ${valueCol} = $1 WHERE ${idCol} = $2`, [encrypt(oldPt, keyNew, ctx), row.id]);
                    colRotated++;
                    continue;
                }
                if (tryDecrypt(envelope, keyNew) !== null) { colAlreadyNew++; continue; }
                console.error(`[rotate] UNREADABLE ${label} for ${idCol}=${quoteId ? JSON.stringify(row.id) : row.id} — broken before this rotation.`);
                colUnreadable++;
            } else {
                // Plaintext legacy value — seal it with NEW (default context).
                await client.query(`UPDATE ${table} SET ${valueCol} = $1 WHERE ${idCol} = $2`, [encrypt(String(row.value), deriveKey(newMaster, null)), row.id]);
                colPlain++;
            }
        }
        console.log(`[rotate] ${label} done — rotated=${colRotated} already_new=${colAlreadyNew} plaintext_sealed=${colPlain} unreadable=${colUnreadable}`);
    }

    try {
        await rotateEnvelopeColumn({ table: 'users', idCol: 'id', valueCol: 'mfa_secret', label: 'users.mfa_secret', quoteId: true });
    } catch (e) {
        console.error('[rotate] users.mfa_secret pass failed (table/column missing?):', e.message);
    }
    try {
        await rotateEnvelopeColumn({ table: 'webpage_public_shares', idCol: 'id', valueCol: 'token_cipher', label: 'webpage_public_shares.token_cipher' });
    } catch (e) {
        console.error('[rotate] webpage_public_shares.token_cipher pass failed (table/column missing?):', e.message);
    }

    // ── orgVault ('routine-vault-v1') columns ───────────────────────
    // Keyed per ORG, from the row's own org_id (empty → the same sentinel
    // integrationConnectionStore.resolveOrgId uses, or the derived keys won't
    // line up). A row that decrypts with neither master was already broken.
    let vaultUnreadable = 0;
    async function rotateOrgVaultColumns({ table, idCol, orgCol, valueCols, label }) {
        const cols = valueCols.join(', ');
        const anyNotNull = valueCols.map(c => `${c} IS NOT NULL`).join(' OR ');
        const { rows: vRows } = await client.query(
            `SELECT ${idCol} AS id, ${orgCol} AS org_id, ${cols} FROM ${table} WHERE ${anyNotNull}`
        );
        let rot = 0, alreadyNew = 0, unread = 0, skipped = 0;
        for (const row of vRows) {
            const orgId = (row.org_id && String(row.org_id).trim()) || DEFAULT_ORG_SENTINEL;
            const keyOld = deriveOrgVaultKey(oldMaster, orgId);
            const keyNew = deriveOrgVaultKey(newMaster, orgId);
            for (const col of valueCols) {
                const raw = row[col];
                if (!raw) continue;
                let envelope;
                try { envelope = JSON.parse(raw); } catch (_) { envelope = null; }
                if (!envelope || envelope._encrypted !== ORG_VAULT_TAG) { skipped++; continue; }
                const oldPt = tryDecrypt(envelope, keyOld);
                if (oldPt !== null) {
                    await client.query(
                        `UPDATE ${table} SET ${col} = $1 WHERE ${idCol} = $2`,
                        [encryptTagged(oldPt, keyNew, ORG_VAULT_TAG), row.id]
                    );
                    rot++;
                    continue;
                }
                if (tryDecrypt(envelope, keyNew) !== null) { alreadyNew++; continue; }
                console.error(`[rotate] UNREADABLE ${label}.${col} for ${idCol}=${JSON.stringify(row.id)} (org=${orgId}) — broken before this rotation.`);
                unread++;
            }
        }
        vaultUnreadable += unread;
        console.log(`[rotate] ${label} done — rotated=${rot} already_new=${alreadyNew} not_sealed=${skipped} unreadable=${unread}`);
    }

    try {
        await rotateOrgVaultColumns({
            table: 'integration_connections', idCol: 'id', orgCol: 'org_id',
            valueCols: ['secret'], label: 'integration_connections',
        });
    } catch (e) {
        console.error('[rotate] integration_connections pass failed (table missing?):', e.message);
    }
    try {
        await rotateOrgVaultColumns({
            table: 'routine_credentials', idCol: 'id', orgCol: 'org_id',
            valueCols: ['access_token', 'refresh_token'], label: 'routine_credentials',
        });
    } catch (e) {
        console.error('[rotate] routine_credentials pass failed (table missing?):', e.message);
    }
    try {
        // The org IS its own key context here, so idCol and orgCol are the same
        // column. This row wraps every user DEK in the org — see the inventory
        // note at the top of this file for what skipping it costs.
        await rotateOrgVaultColumns({
            table: 'organizations', idCol: 'id', orgCol: 'id',
            valueCols: ['org_root_key'], label: 'organizations',
        });
    } catch (e) {
        console.error('[rotate] organizations.org_root_key pass failed (table/column missing?):', e.message);
    }
    try {
        // upsertVoiceprint refuses a row without an organization, so the
        // sentinel branch above is unreachable here — it stays for uniformity.
        await rotateOrgVaultColumns({
            table: 'voiceprints', idCol: 'id', orgCol: 'organization_id',
            valueCols: ['voiceprint_enc'], label: 'voiceprints',
        });
    } catch (e) {
        console.error('[rotate] voiceprints.voiceprint_enc pass failed (table missing?):', e.message);
    }

    // ── users."appPassword" ('appcred-v1', single global key) ───────
    // Untagged v1 blobs are rotated straight to the tagged v2 envelope, so
    // after this pass every row is discoverable by future rotations.
    try {
        const { rows: apRows } = await client.query(
            `SELECT id, "appPassword" AS value FROM users WHERE "appPassword" IS NOT NULL AND "appPassword" <> ''`
        );
        const apOld = deriveAppPwdKey(oldMaster);
        const apNew = deriveAppPwdKey(newMaster);
        const apLegacyOld = deriveLegacyAppPwdKey(oldMaster);
        let rot = 0, alreadyNew = 0, upgraded = 0, unread = 0;
        for (const row of apRows) {
            let envelope;
            try { envelope = JSON.parse(row.value); } catch (_) { envelope = null; }
            if (!envelope || !envelope.iv || !envelope.data) continue;
            const oldPt = tryDecrypt(envelope, apOld);
            if (oldPt !== null) {
                await client.query('UPDATE users SET "appPassword" = $1 WHERE id = $2', [encryptTagged(oldPt, apNew, APP_PWD_TAG), row.id]);
                rot++;
                continue;
            }
            if (tryDecrypt(envelope, apNew) !== null) { alreadyNew++; continue; }
            const legacyPt = tryDecrypt(envelope, apLegacyOld);
            if (legacyPt !== null) {
                await client.query('UPDATE users SET "appPassword" = $1 WHERE id = $2', [encryptTagged(legacyPt, apNew, APP_PWD_TAG), row.id]);
                upgraded++;
                continue;
            }
            // SESSION_SECRET-derived rows from installs that never set a master.
            if (process.env.SESSION_SECRET) {
                const sessPt = tryDecrypt(envelope, deriveLegacyAppPwdKey(process.env.SESSION_SECRET));
                if (sessPt !== null) {
                    await client.query('UPDATE users SET "appPassword" = $1 WHERE id = $2', [encryptTagged(sessPt, apNew, APP_PWD_TAG), row.id]);
                    upgraded++;
                    continue;
                }
            }
            console.error(`[rotate] UNREADABLE users."appPassword" for id=${JSON.stringify(row.id)} — user must re-save it in Settings → Integrations.`);
            unread++;
        }
        vaultUnreadable += unread;
        console.log(`[rotate] users.appPassword done — rotated=${rot} already_new=${alreadyNew} upgraded_from_legacy=${upgraded} unreadable=${unread}`);
    } catch (e) {
        console.error('[rotate] users.appPassword pass failed (column missing?):', e.message);
    }
    // Release the advisory lock explicitly. Releasing the client to the pool
    // does NOT auto-release session locks (the client may be reused).
    try { await client.query('SELECT pg_advisory_unlock($1)', [ROTATION_LOCK_KEY]); } catch (_) { /* ignore */ }
    client.release();
    if (unreadable > 0 || vaultUnreadable > 0) {
        console.error(`[rotate] ${unreadable + vaultUnreadable} row(s) could not be decrypted with either master. Investigate before promoting NEW.`);
        await pool.end();
        process.exit(2);
    }
    await pool.end();
}

// Only rotate when invoked directly. Requiring this file exposes the envelope
// helpers so a test can pin them against the real store modules — if a
// derivation here ever drifts from its source, rotation writes ciphertext the
// app cannot read, and the failure is silent until someone opens the feature.
if (require.main === module) {
    main().catch(err => {
        console.error('[rotate] fatal:', err);
        process.exit(1);
    });
}

module.exports = {
    deriveKey,
    deriveOrgVaultKey,
    deriveAppPwdKey,
    deriveLegacyAppPwdKey,
    encryptTagged,
    tryDecrypt,
    ORG_VAULT_TAG,
    APP_PWD_TAG,
    DEFAULT_ORG_SENTINEL,
};
