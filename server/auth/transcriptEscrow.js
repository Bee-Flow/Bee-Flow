// @typecheck
/**
 * The key a TRANSCRIPTION is encrypted under.
 *
 * ── Why transcriptions cannot use a per-user key ────────────────────────────
 *
 * Every message key in this codebase is per-USER. A transcription is not
 * per-user data: `shared_with` hands it to named colleagues, `is_published`
 * hands it to the whole organisation, and the summary/insight jobs read it
 * with no session in scope at all. A per-user key would mean the second
 * attendee opens an empty meeting and the 3am summary job writes under a key
 * the owner cannot read — the exact split that stores/agent/messageCrypto.js
 * documents for shared project conversations.
 *
 * So a transcription is keyed to the ORGANISATION:
 *
 *   MASTER_ENCRYPTION_KEY → org vault KEK → Org Root Key (per org)
 *                                                │ AES-KW envelope
 *                                                ▼
 *                                    Transcript DEK (per org, STORED)
 *                                                │ HKDF-SHA256
 *                                                ▼
 *                                    Per-transcription key
 *
 * ── WRAPPED, not derived — and this is the part that matters ────────────────
 *
 * auth/projectEscrow.js DERIVES its key from the org root key, which is why
 * `rotateOrgRootKey` has to refuse outright when an org has shared
 * conversations: rotation changes every derived key and orphans the ciphertext
 * behind it. That trade is survivable for project sharing, which an org can
 * unwind before rotating. It is not survivable here. Transcriptions are a
 * permanent archive; "you may never rotate your root key again once you record
 * a meeting" is not a key hierarchy, it is a trap.
 *
 * So the transcript DEK is a random key WRAPPED by the ORK and stored on the
 * organisations row, exactly like `users.orgWrappedDEK`. Rotation rewraps it
 * (see rewrapForRotation below, called from rotateOrgRootKey) and every
 * existing transcription stays readable.
 *
 * The per-transcription HKDF step is kept for the same reason projectEscrow
 * keeps its own: a leaked single-transcription key must not open the archive.
 *
 * ── What this costs, stated plainly ────────────────────────────────────────
 *
 * On the `zk` tier a transcription is readable by the server operator, because
 * the key chains back to MASTER_ENCRYPTION_KEY in their environment. This is
 * the same weakening already accepted for ZK_ESCROW_SURFACES and
 * PROJECT_SHARED_MESSAGES, for the same reason: the alternative is not a
 * stronger transcription, it is no shared or summarised transcription at all.
 * The admin tier card must say so in plain words. A surface that silently
 * protects nothing is worse than one that is honestly labelled.
 */

const crypto = require('crypto');
const { wrapDEK, unwrapDEK, secureClear } = require('./encryption');
const { getOrgRootKey } = require('./orgEscrow');
const log = require('../telemetry/log');

const HKDF_SALT = Buffer.from('beeflow:transcript:hkdf-salt:v1');
const DEK_COLUMN = 'org_transcript_dek';

/** AAD binds the envelope to the organisation it was minted for. */
function transcriptDekAad(orgId) {
    return Buffer.from(`beeflow:transcript-dek:v1:org:${orgId}`);
}

// Same bounded, expiring cache shape as orgEscrow's — an unbounded key cache is
// a leak, and a key cached forever survives a rotation it should not survive.
const _cache = new Map(); // orgId -> { at, key }
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

function _cacheGet(orgId) {
    const hit = _cache.get(orgId);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        _cache.delete(orgId);
        secureClear(hit.key);
        return null;
    }
    return hit.key;
}

function _cacheSet(orgId, key) {
    if (_cache.size >= CACHE_MAX) {
        const oldest = _cache.keys().next().value;
        if (oldest !== undefined) {
            const ev = _cache.get(oldest);
            _cache.delete(oldest);
            if (ev) secureClear(ev.key);
        }
    }
    _cache.set(orgId, { at: Date.now(), key });
}

function invalidateTranscriptKeyCache(orgId) {
    if (orgId === undefined) {
        for (const [, v] of _cache) secureClear(v.key);
        _cache.clear();
        return;
    }
    const hit = _cache.get(String(orgId || ''));
    if (hit) secureClear(hit.key);
    _cache.delete(String(orgId || ''));
}

function _normOrgId(rawOrgId) {
    const orgId = typeof rawOrgId === 'string' ? rawOrgId.trim() : '';
    return orgId || null;
}

/**
 * The organisation's transcript DEK, minting and storing one on first use.
 *
 * Returns null — never throws, never invents a key — when the org has no root
 * key or the envelope will not open. A null key means the caller writes
 * plaintext, which is recoverable; a wrong key means ciphertext nobody can ever
 * open, which is not.
 *
 * @param {string} rawOrgId
 * @param {object} [deps] injection seam for tests
 * @returns {Promise<Buffer|null>}
 */
async function getTranscriptDek(rawOrgId, deps = {}) {
    const orgId = _normOrgId(rawOrgId);
    if (!orgId) return null;

    const cached = _cacheGet(orgId);
    if (cached) return Buffer.from(cached);

    const getOne = deps.getOne || require('../db').getOne;
    const run = deps.run || require('../db').run;
    const ork = await (deps.getOrgRootKey || getOrgRootKey)(orgId);
    if (!ork) {
        log.warn(`[TranscriptEscrow] No org root key for '${orgId}' — transcriptions stay plaintext.`);
        return null;
    }

    let row;
    try {
        row = await getOne(`SELECT "${DEK_COLUMN}" AS dek FROM organizations WHERE id = $1`, [orgId]);
    } catch (e) {
        log.error(`[TranscriptEscrow] Could not read the transcript DEK for '${orgId}': ${e.message}`);
        return null;
    }
    if (!row) return null;

    if (row.dek) {
        let envelope;
        try { envelope = JSON.parse(row.dek); } catch (_) { envelope = null; }
        const dek = envelope ? unwrapDEK(envelope, ork, transcriptDekAad(orgId)) : null;
        if (!dek) {
            // Loud, and null rather than a fresh key: minting a new one here
            // would leave every existing transcription permanently unreadable
            // while the org saw no error at all.
            log.error(`[TranscriptEscrow] The stored transcript DEK for '${orgId}' will not open. Existing transcriptions cannot be read; NOT minting a replacement.`);
            return null;
        }
        _cacheSet(orgId, Buffer.from(dek));
        return dek;
    }

    // First use for this org: mint and store.
    const dek = crypto.randomBytes(32);
    const sealed = JSON.stringify(wrapDEK(dek, ork, transcriptDekAad(orgId)));
    try {
        await run(`UPDATE organizations SET "${DEK_COLUMN}" = $1 WHERE id = $2 AND "${DEK_COLUMN}" IS NULL`, [sealed, orgId]);
    } catch (e) {
        secureClear(dek);
        log.error(`[TranscriptEscrow] Could not store a transcript DEK for '${orgId}': ${e.message}`);
        return null;
    }
    // Re-read rather than trust the UPDATE: two workers can mint concurrently
    // and only one row survives. Writing under the key that LOST would produce
    // ciphertext the winner cannot open.
    let fresh;
    try {
        fresh = await getOne(`SELECT "${DEK_COLUMN}" AS dek FROM organizations WHERE id = $1`, [orgId]);
    } catch (_) { fresh = null; }
    secureClear(dek);
    if (!fresh || !fresh.dek) return null;
    let envelope;
    try { envelope = JSON.parse(fresh.dek); } catch (_) { return null; }
    const winner = unwrapDEK(envelope, ork, transcriptDekAad(orgId));
    if (!winner) return null;
    _cacheSet(orgId, Buffer.from(winner));
    return winner;
}

/**
 * The key for ONE transcription. A leaked per-transcription key must not open
 * the rest of the archive, so the org DEK is never used directly.
 *
 * @param {Buffer} dek the org transcript DEK
 * @param {string} transcriptionId
 * @returns {Buffer}
 */
function transcriptionKey(dek, transcriptionId) {
    return Buffer.from(
        crypto.hkdfSync('sha256', dek, HKDF_SALT, `beeflow:transcript:v1:id:${transcriptionId}`, 32)
    );
}

/**
 * Rewrap the org's transcript DEK from one root key to another.
 *
 * Called by orgEscrow.rotateOrgRootKey INSIDE its all-or-nothing phase: it
 * returns the new envelope without writing, so the caller can abort the whole
 * rotation if anything cannot be rewrapped. An org with no transcript DEK yet
 * returns null, which is not a failure.
 *
 * @returns {Promise<string|null>} the new envelope, or null if there is nothing to rewrap
 * @throws when a DEK exists but will not open under the old root key
 */
async function rewrapForRotation(rawOrgId, oldOrk, newOrk, deps = {}) {
    const orgId = _normOrgId(rawOrgId);
    if (!orgId) return null;
    const getOne = deps.getOne || require('../db').getOne;
    const row = await getOne(`SELECT "${DEK_COLUMN}" AS dek FROM organizations WHERE id = $1`, [orgId]);
    if (!row || !row.dek) return null;

    let envelope;
    try { envelope = JSON.parse(row.dek); } catch (_) { envelope = null; }
    const dek = envelope ? unwrapDEK(envelope, oldOrk, transcriptDekAad(orgId)) : null;
    if (!dek) {
        // Thrown, not swallowed: rotating past this would leave every
        // transcription in the organisation permanently unreadable.
        throw new Error(
            `[TranscriptEscrow] The transcript DEK for '${orgId}' could not be rewrapped. ` +
            'Rotating anyway would strand every transcription in this organisation.'
        );
    }
    const sealed = JSON.stringify(wrapDEK(dek, newOrk, transcriptDekAad(orgId)));
    secureClear(dek);
    return sealed;
}

module.exports = {
    DEK_COLUMN,
    transcriptDekAad,
    getTranscriptDek,
    transcriptionKey,
    rewrapForRotation,
    invalidateTranscriptKeyCache,
};
