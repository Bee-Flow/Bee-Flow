// @typecheck
// Pending Nextcloud bindings — email-match approvals, pairing codes, and
// email-code verification for binding an NC instance to an organisation.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');

// ── Pending NC bindings ───────────────────────────────────────────────────

function parsePendingBinding(row) {
    if (!row) return null;
    return {
        id: row.id,
        orgId: row.org_id,
        ncInstanceId: row.nc_instance_id,
        ncBaseUrl: row.nc_base_url,
        ncAdminUid: row.nc_admin_uid,
        ncAdminEmail: row.nc_admin_email,
        ncAdminDisplayName: row.nc_admin_display_name,
        connectorCallbackUrl: row.connector_callback_url,
        themingName: row.theming_name,
        ncVersion: row.nc_version,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        approvedAt: row.approved_at,
        approvedByUserId: row.approved_by_user_id,
        pairingCode: row.pairing_code || null,
        pairingCodeConsumedAt: row.pairing_code_consumed_at || null,
        verificationEmail: row.verification_email || null,
        verificationAttempts: row.verification_attempts || 0,
        hasVerification: !!row.verification_code_hash,
    };
}

// ── Email-code verification helpers ──
const NC_VERIFICATION_TTL_SECONDS = 15 * 60;
const NC_VERIFICATION_MAX_ATTEMPTS = 5;

// Salt the code hash with org_id:nc_instance_id (both stable across the
// createPendingNcVerification upsert) rather than the row id — ON CONFLICT keeps
// the original row id, so an id-based salt would desync on re-bootstrap.
function _hashNcVerificationCode(orgId, ncInstanceId, code) {
    return crypto.createHash('sha256')
        .update(`${orgId}:${ncInstanceId}:${code}`)
        .digest('hex');
}

function _ncCodeMatches(row, code) {
    if (!row?.verification_code_hash || !code) return false;
    const expected = _hashNcVerificationCode(row.org_id, row.nc_instance_id, code);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(row.verification_code_hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Pairing-code helpers (Phase 2 branch B) ──

// Generate a human-friendly 8-char code split with a dash (e.g. "BEEF-FL0W").
// Excludes ambiguous glyphs (0/O, 1/I/L, etc.) so the admin can read it off a
// screen and type it on another machine without mistakes.
function _generatePairingCodeString() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
    const pickN = (n) => Array.from(crypto.randomBytes(n))
        .map(b => alphabet[b % alphabet.length])
        .join('');
    return `${pickN(4)}-${pickN(4)}`;
}

// Mint a new pairing code for an org. Caller (the SaaS endpoint) is responsible
// for org-admin auth. We always create a fresh row — the unique index on
// pairing_code (active) prevents two unused codes from colliding by chance.
/**
 * @param orgId
 * @param {{ mintedByUserId?: string, ttlSeconds?: number }} [opts]
 */
async function createOrgPairingCode(orgId, { mintedByUserId, ttlSeconds = 900 } = {}) {
    if (!orgId) throw new Error('orgId required');
    await initDB();
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    // Retry on the (extremely rare) collision against an active code.
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = _generatePairingCodeString();
        try {
            const row = await getOne(`
                INSERT INTO pending_nc_bindings
                    (id, org_id, pairing_code, expires_at, approved_by_user_id)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `, [id, orgId, code, expiresAt, mintedByUserId || null]);
            return parsePendingBinding(row);
        } catch (e) {
            if (/idx_pending_nc_bindings_pairing_code_active/i.test(e.message)) continue;
            throw e;
        }
    }
    throw new Error('Failed to mint pairing code after 5 attempts');
}

async function getPendingBindingByPairingCode(code) {
    if (!code) return null;
    await initDB();
    const row = await getOne(`
        SELECT * FROM pending_nc_bindings
        WHERE pairing_code = $1
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL
          AND expires_at > NOW()
        LIMIT 1
    `, [String(code).trim().toUpperCase()]);
    return parsePendingBinding(row);
}

// Mark code consumed. Returns false if the row was already consumed or no
// longer pending — caller treats that as "code already used".
/**
 * @param id
 * @param {{ ncInstanceId?: string, ncBaseUrl?: string, ncAdminUid?: string, ncAdminEmail?: string, ncAdminDisplayName?: string, connectorCallbackUrl?: string, themingName?: string, ncVersion?: string }} [opts]
 */
async function consumePairingCode(id, { ncInstanceId, ncBaseUrl, ncAdminUid, ncAdminEmail, ncAdminDisplayName, connectorCallbackUrl, themingName, ncVersion } = {}) {
    if (!id) return false;
    await initDB();
    const res = await run(`
        UPDATE pending_nc_bindings SET
            pairing_code_consumed_at = NOW(),
            status = 'approved',
            approved_at = NOW(),
            nc_instance_id = COALESCE($2, nc_instance_id),
            nc_base_url    = COALESCE($3, nc_base_url),
            nc_admin_uid   = COALESCE($4, nc_admin_uid),
            nc_admin_email = COALESCE($5, nc_admin_email),
            nc_admin_display_name = COALESCE($6, nc_admin_display_name),
            connector_callback_url = COALESCE($7, connector_callback_url),
            theming_name   = COALESCE($8, theming_name),
            nc_version     = COALESCE($9, nc_version)
        WHERE id = $1
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL
    `, [
        id,
        ncInstanceId || null,
        ncBaseUrl || null,
        ncAdminUid || null,
        ncAdminEmail || null,
        ncAdminDisplayName || null,
        connectorCallbackUrl || null,
        themingName || null,
        ncVersion || null,
    ]);
    return (res?.rowCount || 0) > 0;
}

async function getActivePairingCodesForOrg(orgId) {
    if (!orgId) return [];
    await initDB();
    const rows = await getAll(`
        SELECT * FROM pending_nc_bindings
        WHERE org_id = $1
          AND pairing_code IS NOT NULL
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
    `, [orgId]);
    return rows.map(parsePendingBinding);
}

async function deletePairingCode(id, orgId) {
    if (!id) return false;
    await initDB();
    const res = await run(`
        DELETE FROM pending_nc_bindings
        WHERE id = $1
          AND ($2::text IS NULL OR org_id = $2)
          AND pairing_code IS NOT NULL
          AND pairing_code_consumed_at IS NULL
    `, [id, orgId || null]);
    return (res?.rowCount || 0) > 0;
}

async function createPendingNcBinding(data, ttlSeconds = 1800) {
    await initDB();
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    // ON CONFLICT on the partial unique index (org_id, nc_instance_id) WHERE status='pending'.
    // PG requires repeating the index predicate for index inference.
    const sql = `
        INSERT INTO pending_nc_bindings
            (id, org_id, nc_instance_id, nc_base_url, nc_admin_uid, nc_admin_email,
             nc_admin_display_name, connector_callback_url, theming_name, nc_version, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (org_id, nc_instance_id) WHERE status = 'pending'
        DO UPDATE SET
            nc_base_url = EXCLUDED.nc_base_url,
            nc_admin_uid = EXCLUDED.nc_admin_uid,
            nc_admin_email = EXCLUDED.nc_admin_email,
            nc_admin_display_name = EXCLUDED.nc_admin_display_name,
            connector_callback_url = EXCLUDED.connector_callback_url,
            theming_name = EXCLUDED.theming_name,
            nc_version = EXCLUDED.nc_version,
            expires_at = GREATEST(pending_nc_bindings.expires_at, EXCLUDED.expires_at)
        RETURNING *
    `;
    const row = await getOne(sql, [
        id,
        data.orgId,
        data.ncInstanceId,
        data.ncBaseUrl,
        data.ncAdminUid,
        data.ncAdminEmail,
        data.ncAdminDisplayName || null,
        data.connectorCallbackUrl || null,
        data.themingName || null,
        data.ncVersion || null,
        expiresAt,
    ]);
    return parsePendingBinding(row);
}

// Create (or refresh) a pending email-verification binding and store the hash of
// the supplied one-time `code`. Returns the row (incl. expiresAt) so the caller
// can email the code and report the expiry to the connector. ON CONFLICT on the
// (org_id, nc_instance_id) partial unique index means a re-bootstrap from the
// same instance refreshes the existing row's code + resets attempts.
/**
 * @param data
 * @param {{ ttlSeconds?: number, code?: string }} [opts]
 */
async function createPendingNcVerification(data, { ttlSeconds = NC_VERIFICATION_TTL_SECONDS, code } = {}) {
    if (!data?.orgId || !data?.ncInstanceId || !code) throw new Error('orgId, ncInstanceId and code required');
    await initDB();
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const hash = _hashNcVerificationCode(data.orgId, data.ncInstanceId, code);
    const sql = `
        INSERT INTO pending_nc_bindings
            (id, org_id, nc_instance_id, nc_base_url, nc_admin_uid, nc_admin_email,
             nc_admin_display_name, connector_callback_url, theming_name, nc_version,
             expires_at, verification_code_hash, verification_email, verification_attempts)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0)
        ON CONFLICT (org_id, nc_instance_id) WHERE status = 'pending'
        DO UPDATE SET
            nc_base_url = EXCLUDED.nc_base_url,
            nc_admin_uid = EXCLUDED.nc_admin_uid,
            nc_admin_email = EXCLUDED.nc_admin_email,
            nc_admin_display_name = EXCLUDED.nc_admin_display_name,
            connector_callback_url = EXCLUDED.connector_callback_url,
            theming_name = EXCLUDED.theming_name,
            nc_version = EXCLUDED.nc_version,
            expires_at = EXCLUDED.expires_at,
            verification_code_hash = EXCLUDED.verification_code_hash,
            verification_email = EXCLUDED.verification_email,
            verification_attempts = 0
        RETURNING *
    `;
    const row = await getOne(sql, [
        id,
        data.orgId,
        data.ncInstanceId,
        data.ncBaseUrl || null,
        data.ncAdminUid || null,
        data.ncAdminEmail || null,
        data.ncAdminDisplayName || null,
        data.connectorCallbackUrl || null,
        data.themingName || null,
        data.ncVersion || null,
        expiresAt,
        hash,
        data.verificationEmail || data.ncAdminEmail || null,
    ]);
    return parsePendingBinding(row);
}

// Verify a submitted code against a pending verification row. Atomically counts
// the attempt. Returns a discriminated result; on 'ok' the row is left 'pending'
// — the caller binds the org and marks it approved (mirrors the approve handler)
// so a mid-flight failure doesn't burn the binding.
async function verifyPendingNcCode(id, code) {
    if (!id) return { status: 'not_found' };
    await initDB();
    const existing = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    if (!existing) return { status: 'not_found' };
    if (!existing.verification_code_hash) return { status: 'not_verification' };

    const expired = existing.expires_at && new Date(existing.expires_at).getTime() <= Date.now();
    // Idempotent re-verify after a successful approval (e.g. the connector lost
    // the first response): accept the matching code and hand the row back.
    if (existing.status === 'approved') {
        return _ncCodeMatches(existing, code)
            ? { status: 'ok', row: parsePendingBinding(existing) }
            : { status: 'invalid', attemptsLeft: 0 };
    }
    if (existing.status === 'denied') return { status: 'denied' };
    if (existing.status === 'expired' || (existing.status === 'pending' && expired)) {
        return { status: 'expired' };
    }

    // Count this attempt atomically against a still-valid pending row.
    const row = await getOne(
        `UPDATE pending_nc_bindings SET verification_attempts = verification_attempts + 1
         WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
           AND verification_code_hash IS NOT NULL
         RETURNING *`,
        [id]
    );
    if (!row) return { status: 'expired' };
    if ((row.verification_attempts || 0) > NC_VERIFICATION_MAX_ATTEMPTS) {
        return { status: 'too_many' };
    }
    if (!_ncCodeMatches(row, code)) {
        return { status: 'invalid', attemptsLeft: Math.max(0, NC_VERIFICATION_MAX_ATTEMPTS - (row.verification_attempts || 0)) };
    }
    return { status: 'ok', row: parsePendingBinding(row) };
}

// Resend: mint a new code for an existing pending verification row, reset the
// attempt counter and extend the TTL. Returns the refreshed row (with
// verificationEmail) or null if the row isn't an eligible pending verification.
async function resetNcVerificationCode(id, code, ttlSeconds = NC_VERIFICATION_TTL_SECONDS) {
    if (!id || !code) return null;
    await initDB();
    const existing = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    if (!existing || !existing.verification_code_hash || existing.status !== 'pending') return null;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const hash = _hashNcVerificationCode(existing.org_id, existing.nc_instance_id, code);
    const row = await getOne(
        `UPDATE pending_nc_bindings
            SET verification_code_hash = $2, verification_attempts = 0, expires_at = $3
          WHERE id = $1 AND status = 'pending' AND verification_code_hash IS NOT NULL
          RETURNING *`,
        [id, hash, expiresAt]
    );
    return parsePendingBinding(row);
}

// Re-point a pending verification at a different admin (the NC user actually
// performing the setup, rather than the arbitrary first admin chosen at
// bootstrap): swap the target email + admin identity, mint a fresh code, reset
// attempts and extend the TTL. The caller MUST first validate that `email`
// qualifies for the row's org (exact user match or matching corporate domain).
async function retargetNcVerification(id, { email, uid, displayName, code, ttlSeconds = NC_VERIFICATION_TTL_SECONDS }) {
    if (!id || !email || !code) return null;
    await initDB();
    const existing = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    if (!existing || !existing.verification_code_hash || existing.status !== 'pending') return null;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const hash = _hashNcVerificationCode(existing.org_id, existing.nc_instance_id, code);
    const row = await getOne(
        `UPDATE pending_nc_bindings
            SET verification_email = $2,
                nc_admin_email = $2,
                nc_admin_uid = COALESCE($3, nc_admin_uid),
                nc_admin_display_name = COALESCE($4, nc_admin_display_name),
                verification_code_hash = $5,
                verification_attempts = 0,
                expires_at = $6
          WHERE id = $1 AND status = 'pending' AND verification_code_hash IS NOT NULL
          RETURNING *`,
        [id, String(email).toLowerCase(), uid || null, displayName || null, hash, expiresAt]
    );
    return parsePendingBinding(row);
}

async function countActivePendingNcVerificationsForOrg(orgId) {
    if (!orgId) return 0;
    await initDB();
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM pending_nc_bindings
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND verification_code_hash IS NOT NULL`,
        [orgId]
    );
    return row?.n || 0;
}

async function getPendingNcBinding(id) {
    if (!id) return null;
    await initDB();
    const row = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    return parsePendingBinding(row);
}

async function getPendingNcBindingForOrg(orgId) {
    if (!orgId) return null;
    await initDB();
    // Email-match approval rows only. Pairing-code rows live in the same
    // table but are a different flow (the connector redeems them on
    // bootstrap, never the SPA), so they must not surface in the approval
    // modal. Distinguishing column: pairing_code IS NULL for approval rows.
    const row = await getOne(
        `SELECT * FROM pending_nc_bindings
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND pairing_code IS NULL
           AND verification_code_hash IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [orgId]
    );
    return parsePendingBinding(row);
}

async function countActivePendingNcBindingsForOrg(orgId) {
    if (!orgId) return 0;
    await initDB();
    // Mirror getPendingNcBindingForOrg — count only approval rows so the
    // bootstrap rate-limit "too many pending bindings" check doesn't false-
    // trip on accumulated unused pairing codes.
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM pending_nc_bindings
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > NOW()
           AND pairing_code IS NULL
           AND verification_code_hash IS NULL`,
        [orgId]
    );
    return row?.n || 0;
}

async function markPendingNcBindingApproved(id, userId) {
    await initDB();
    await run(
        `UPDATE pending_nc_bindings SET status = 'approved', approved_at = NOW(), approved_by_user_id = $2
         WHERE id = $1 AND status = 'pending'`,
        [id, userId || null]
    );
}

async function markPendingNcBindingDenied(id, userId) {
    await initDB();
    await run(
        `UPDATE pending_nc_bindings SET status = 'denied', approved_at = NOW(), approved_by_user_id = $2
         WHERE id = $1 AND status = 'pending'`,
        [id, userId || null]
    );
}

async function expirePendingNcBindings() {
    await initDB();
    const res = await run(
        `UPDATE pending_nc_bindings SET status = 'expired'
         WHERE status = 'pending' AND expires_at <= NOW()`
    );
    return res?.rowCount || 0;
}

module.exports = {
    createPendingNcBinding, getPendingNcBinding, getPendingNcBindingForOrg,
    createPendingNcVerification, verifyPendingNcCode, resetNcVerificationCode,
    retargetNcVerification, countActivePendingNcVerificationsForOrg,
    createOrgPairingCode, getPendingBindingByPairingCode, consumePairingCode,
    getActivePairingCodesForOrg, deletePairingCode,
    countActivePendingNcBindingsForOrg, markPendingNcBindingApproved,
    markPendingNcBindingDenied, expirePendingNcBindings,
};
