// @typecheck
// Consent ledger — append-only legal-document acceptances plus the cached
// per-user consent summaries and optional (marketing) consents.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJSON } = require('./shared');
const log = require('../../telemetry/log');

// ── Consent ledger ────────────────────────────────────────────────────────
// Append-only record of legal-document acceptances. Never throws (best-effort,
// like logAccessAudit) but the consent GATE itself is hard — callers must
// validate consent BEFORE creating the account and only call this to record it.

async function recordConsentAcceptance(row) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        await run(
            `INSERT INTO consent_acceptances
                (id, user_id, email, account_type, doc_id, doc_version, doc_sha256, method, route, ip, user_agent, organization_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
                id,
                row.userId,
                row.email || null,
                row.accountType,
                row.docId,
                Number(row.docVersion),
                row.docSha256 || null,
                row.method,
                row.route || null,
                row.ip || null,
                row.userAgent || null,
                row.organizationId || null,
            ]
        );
        return id;
    } catch (e) { log.error('[UserStore] Consent ledger error:', e.message); return null; }
}

async function getConsentAcceptances(userId, limit = 200) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM consent_acceptances WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
    );
    return rows;
}

// Admin-facing ledger view across all users (optionally filtered by doc).
async function listConsentAcceptances({ docId = null, limit = 100, offset = 0 } = {}) {
    await initDB();
    const params = [];
    let sql = 'SELECT * FROM consent_acceptances';
    let idx = 1;
    if (docId) { sql += ` WHERE doc_id = $${idx++}`; params.push(docId); }
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    return await getAll(sql, params);
}

// Optional (marketing) consents — current state cached on the user row; the
// consent_acceptances ledger holds the grant/withdraw audit trail.
async function getOptionalConsents(userId) {
    await initDB();
    const row = await getOne(`SELECT optional_consents FROM users WHERE id = $1`, [userId]);
    return parseJSON(row?.optional_consents, {}) || {};
}

async function setOptionalConsents(userId, map) {
    await initDB();
    await run(`UPDATE users SET optional_consents = $1 WHERE id = $2`, [JSON.stringify(map || {}), userId]);
}

// Cached { docId: acceptedVersion } summary on the user row — fast re-consent
// detection without scanning the ledger.
async function getConsentSummary(userId) {
    await initDB();
    const row = await getOne(`SELECT accepted_legal_versions FROM users WHERE id = $1`, [userId]);
    return parseJSON(row?.accepted_legal_versions, {}) || {};
}

async function setConsentSummary(userId, map) {
    await initDB();
    await run(`UPDATE users SET accepted_legal_versions = $1 WHERE id = $2`, [JSON.stringify(map || {}), userId]);
}

module.exports = {
    recordConsentAcceptance, getConsentAcceptances, listConsentAcceptances,
    getConsentSummary, setConsentSummary,
    getOptionalConsents, setOptionalConsents,
};
