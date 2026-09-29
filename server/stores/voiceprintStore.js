// @typecheck
/**
 * Voiceprint Store — per-person pyannoteAI speaker templates.
 *
 * A voiceprint is an opaque base64 template produced by pyannoteAI's
 * `POST /v1/voiceprint` from ~25s of one person's speech. It lets a later
 * `/v1/identify` job put a real name on a diarized speaker acoustically,
 * instead of the LLM guessing from the transcript text.
 *
 * This is BIOMETRIC DATA (GDPR Art. 9 special category). Three rules are
 * structural, not cosmetic:
 *
 *   1. Only the owner ever creates one. There is no store function and no
 *      route that takes a "target user" — enrollment always derives the user
 *      from the session. Do not add one.
 *   2. The template never leaves this module in plaintext except into the
 *      pyannote request body. `getVoiceprintForUser` returns METADATA ONLY,
 *      at every privilege level including super-admin.
 *   3. It is encrypted at rest with `orgVault` (per-org key derived from
 *      MASTER_ENCRYPTION_KEY), NOT with the SESSION_SECRET-based secretBox:
 *      a session-secret rotation is a routine security action and would
 *      silently destroy every enrollment, and a single global key gives no
 *      per-org blast-radius isolation for Art. 9 data.
 *
 * Because the key is per-org, a template is cryptographically bound to the
 * organisation whose members consented to it. A user who moves org can no
 * longer be matched there (the row is filtered out by the membership join)
 * AND their old blob no longer decrypts — both correct. A voiceprint must
 * never silently follow a person into a second organisation; if multi-org
 * membership ever lands, enrollment stays per (user, org).
 *
 * One row per (user, provider): a retake is an UPSERT, so there is no
 * enrollment history to leak. The enrollment AUDIO is never stored anywhere.
 */

'use strict';

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const orgVault = require('./orgVault');
const log = require('../telemetry/log');

const DEFAULT_PROVIDER = 'pyannote';

const initDB = makeStoreInit('VoiceprintStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS voiceprints (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'pyannote',
            model TEXT NOT NULL DEFAULT 'precision-2',
            voiceprint_enc TEXT,
            voiceprint_chars INTEGER NOT NULL DEFAULT 0,
            duration_seconds NUMERIC,
            language TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            error_code TEXT,
            job_id TEXT,
            consent_at TIMESTAMPTZ,
            consent_version INTEGER DEFAULT 1,
            consent_ip TEXT,
            consent_user_agent TEXT,
            last_matched_at TIMESTAMPTZ,
            match_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_voiceprints_user_provider ON voiceprints(user_id, provider);
        CREATE INDEX IF NOT EXISTS idx_voiceprints_org_ready ON voiceprints(organization_id) WHERE status = 'ready';
    `);
    log.info('[VoiceprintStore] PostgreSQL initialized');
}

/** Public (safe) shape of a row — never carries the template. */
function toMeta(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        provider: row.provider,
        model: row.model,
        durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
        language: row.language || null,
        status: row.status,
        errorCode: row.error_code || null,
        consentAt: row.consent_at || null,
        consentVersion: row.consent_version != null ? Number(row.consent_version) : null,
        lastMatchedAt: row.last_matched_at || null,
        matchCount: Number(row.match_count) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Record that an enrollment is in flight, before the pyannote job runs.
 *
 * Without this a crash mid-job leaves no trace and the user sees "not
 * enrolled" with no explanation of the failed attempt. The row is replaced
 * wholesale by `upsertVoiceprint` on success.
 *
 * @param {{userId: string, organizationId: string, provider?: string,
 *          language?: string, consent?: {at?: Date, version?: number, ip?: string, userAgent?: string}}} args
 */
async function markPending({ userId, organizationId, provider = DEFAULT_PROVIDER, language = null, consent = {} }) {
    await initDB();
    if (!userId || !organizationId) throw new Error('markPending requires userId and organizationId');
    const id = `vp_${crypto.randomUUID()}`;
    await run(
        `INSERT INTO voiceprints (id, user_id, organization_id, provider, language, status,
                                  consent_at, consent_version, consent_ip, consent_user_agent, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, NOW())
         ON CONFLICT (user_id, provider) DO UPDATE SET
            organization_id = EXCLUDED.organization_id,
            language = EXCLUDED.language,
            -- A RETAKE must not un-enrol you. Only a user with no working
            -- template goes to 'pending'; someone who already has one stays
            -- 'ready' and keeps being matched in meetings while the new
            -- recording is processed. If the attempt then fails (too short,
            -- too quiet, pyannote 400) they simply keep the profile they had.
            status = CASE WHEN voiceprints.voiceprint_enc IS NULL THEN 'pending' ELSE 'ready' END,
            error_code = NULL,
            consent_at = EXCLUDED.consent_at,
            consent_version = EXCLUDED.consent_version,
            consent_ip = EXCLUDED.consent_ip,
            consent_user_agent = EXCLUDED.consent_user_agent,
            updated_at = NOW()`,
        [id, userId, organizationId, provider, language,
            consent.at || new Date(), consent.version || 1, consent.ip || null, consent.userAgent || null]
    );
    return getVoiceprintForUser(userId, provider);
}

/**
 * Flag a failed enrollment so the UI can offer a retake with a reason.
 *
 * NEVER touches `voiceprint_enc`. A failed ATTEMPT is not a reason to destroy
 * the template the user already consented to and is being matched by: this used
 * to NULL the blob, so anyone with a working profile who tapped "record again"
 * and stopped two seconds early lost it to a plain 400. Only
 * `upsertVoiceprint` may write that column.
 */
async function markFailed(userId, provider, errorCode) {
    await initDB();
    await run(
        `UPDATE voiceprints
            SET status = CASE WHEN voiceprint_enc IS NULL THEN 'failed' ELSE 'ready' END,
                error_code = $3,
                updated_at = NOW()
          WHERE user_id = $1 AND provider = $2`,
        [userId, provider || DEFAULT_PROVIDER, String(errorCode || 'enroll_failed').slice(0, 64)]
    );
}

/**
 * Store (or replace) a user's voiceprint. The template is encrypted under the
 * org's vault key before it touches the DB.
 *
 * @returns {Promise<object>} the metadata row (never the template)
 * @param {{userId: string, organizationId: string, provider?: string, model?: string, voiceprintBase64: string, durationSeconds?: number|null, language?: string|null, jobId?: string|null, consent?: {at?: Date, version?: number, ip?: string, userAgent?: string}}} opts
 */
async function upsertVoiceprint({
    userId, organizationId, provider = DEFAULT_PROVIDER, model = 'precision-2',
    voiceprintBase64, durationSeconds = null, language = null, jobId = null, consent = {},
}) {
    await initDB();
    if (!userId || !organizationId) throw new Error('upsertVoiceprint requires userId and organizationId');
    if (!voiceprintBase64 || typeof voiceprintBase64 !== 'string') {
        throw new Error('upsertVoiceprint requires a voiceprint template');
    }
    const enc = orgVault.encrypt(voiceprintBase64, organizationId);
    if (!enc) throw new Error('Could not encrypt the voiceprint template');

    const id = `vp_${crypto.randomUUID()}`;
    await run(
        `INSERT INTO voiceprints (id, user_id, organization_id, provider, model, voiceprint_enc,
                                  voiceprint_chars, duration_seconds, language, status, error_code, job_id,
                                  consent_at, consent_version, consent_ip, consent_user_agent, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ready', NULL, $10, $11, $12, $13, $14, NOW())
         ON CONFLICT (user_id, provider) DO UPDATE SET
            organization_id = EXCLUDED.organization_id,
            model = EXCLUDED.model,
            voiceprint_enc = EXCLUDED.voiceprint_enc,
            voiceprint_chars = EXCLUDED.voiceprint_chars,
            duration_seconds = EXCLUDED.duration_seconds,
            language = EXCLUDED.language,
            status = 'ready',
            error_code = NULL,
            job_id = EXCLUDED.job_id,
            consent_at = EXCLUDED.consent_at,
            consent_version = EXCLUDED.consent_version,
            consent_ip = EXCLUDED.consent_ip,
            consent_user_agent = EXCLUDED.consent_user_agent,
            -- A retake is a NEW template: reset the match counters so ranking
            -- reflects the print actually in use, not its predecessor.
            last_matched_at = NULL,
            match_count = 0,
            updated_at = NOW()`,
        [id, userId, organizationId, provider, model, enc, voiceprintBase64.length,
            durationSeconds, language, jobId,
            consent.at || new Date(), consent.version || 1, consent.ip || null, consent.userAgent || null]
    );
    log.info(`[VoiceprintStore] Stored voiceprint for user ${userId} (org ${organizationId}, ${voiceprintBase64.length} chars)`);
    return getVoiceprintForUser(userId, provider);
}

/**
 * A user's own voiceprint — METADATA ONLY. There is deliberately no variant
 * of this that returns the template; the only reader of the plaintext is
 * `loadVoiceprintBlobs`, which feeds the pyannote request directly.
 */
async function getVoiceprintForUser(userId, provider = DEFAULT_PROVIDER) {
    await initDB();
    const row = await getOne(
        `SELECT * FROM voiceprints WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
    );
    return toMeta(row);
}

/**
 * Ready voiceprints for an org, for the ranking phase — NO decryption.
 *
 * Membership comes from the `users` join, not from the cached
 * `organization_id`, so it is always current: someone who left the org stops
 * being matched without any cleanup job.
 *
 * @returns {Promise<Array<{id, userId, displayName, lastMatchedAt, matchCount, createdAt}>>}
 */
async function listOrgVoiceprintMeta(orgId, provider = DEFAULT_PROVIDER) {
    await initDB();
    if (!orgId) return [];
    const rows = await getAll(
        `SELECT v.id, v.user_id, v.last_matched_at, v.match_count, v.created_at,
                u."displayName" AS display_name, u."firstName" AS first_name,
                u."lastName" AS last_name, u.email
           FROM voiceprints v
           JOIN users u ON u.id = v.user_id
          WHERE u."organizationId" = $1
            AND v.provider = $2
            AND v.status = 'ready'
            AND v.voiceprint_enc IS NOT NULL`,
        [orgId, provider]
    );
    return (rows || []).map(r => ({
        id: r.id,
        userId: r.user_id,
        displayName: r.display_name || null,
        firstName: r.first_name || null,
        lastName: r.last_name || null,
        email: r.email || null,
        lastMatchedAt: r.last_matched_at || null,
        matchCount: Number(r.match_count) || 0,
        createdAt: r.created_at,
    }));
}

/**
 * Decrypt the chosen templates. Called with at most `max` ids (the API caps
 * an identify job at 50) so a large org never decrypts megabytes per meeting.
 *
 * A row that fails to decrypt (org changed, master key rotated without the
 * table being re-encrypted) is SKIPPED, not thrown: a broken template must
 * cost that person their name, never the whole meeting.
 *
 * @returns {Promise<Array<{id: string, userId: string, voiceprint: string}>>}
 */
async function loadVoiceprintBlobs(ids, orgId) {
    await initDB();
    if (!Array.isArray(ids) || ids.length === 0 || !orgId) return [];
    const rows = await getAll(
        `SELECT id, user_id, voiceprint_enc FROM voiceprints WHERE id = ANY($1)`,
        [ids]
    );
    const out = [];
    let undecryptable = 0;
    for (const r of rows || []) {
        const plain = orgVault.decrypt(r.voiceprint_enc, orgId);
        if (!plain) { undecryptable += 1; continue; }
        out.push({ id: r.id, userId: r.user_id, voiceprint: plain });
    }
    if (undecryptable) {
        log.warn(`[VoiceprintStore] ${undecryptable} voiceprint(s) could not be decrypted for org ${orgId} — those users need to re-record`);
    }
    return out;
}

/** { enrolled, members } for the org coverage panel. */
async function countOrgCoverage(orgId, provider = DEFAULT_PROVIDER) {
    await initDB();
    if (!orgId) return { enrolled: 0, members: 0 };
    const row = await getOne(
        `SELECT (SELECT COUNT(*)::int FROM users WHERE "organizationId" = $1) AS members,
                (SELECT COUNT(*)::int FROM voiceprints v JOIN users u ON u.id = v.user_id
                  WHERE u."organizationId" = $1 AND v.provider = $2 AND v.status = 'ready') AS enrolled`,
        [orgId, provider]
    );
    return { enrolled: Number(row?.enrolled) || 0, members: Number(row?.members) || 0 };
}

/** Bump match telemetry — drives the "who is usually in this org's meetings" ranking. */
async function recordMatches(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
        await initDB();
        await run(
            `UPDATE voiceprints SET last_matched_at = NOW(), match_count = match_count + 1, updated_at = NOW()
              WHERE id = ANY($1)`,
            [ids]
        );
    } catch (e) {
        log.warn('[VoiceprintStore] recordMatches failed:', e.message);
    }
}

async function deleteVoiceprintForUser(userId, provider = DEFAULT_PROVIDER) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM voiceprints WHERE user_id = $1 AND provider = $2`,
        [userId, provider]
    );
    if (rowCount > 0) log.info(`[VoiceprintStore] Deleted voiceprint for user ${userId}`);
    return rowCount > 0;
}

async function deleteVoiceprintsForOrg(orgId) {
    await initDB();
    const { rowCount } = await run(`DELETE FROM voiceprints WHERE organization_id = $1`, [orgId]);
    return rowCount;
}

module.exports = {
    DEFAULT_PROVIDER,
    markPending,
    markFailed,
    upsertVoiceprint,
    getVoiceprintForUser,
    listOrgVoiceprintMeta,
    loadVoiceprintBlobs,
    countOrgCoverage,
    recordMatches,
    deleteVoiceprintForUser,
    deleteVoiceprintsForOrg,
    // exported for tests
    toMeta,
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
