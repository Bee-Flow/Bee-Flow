// @typecheck
/**
 * AI Act Assessment Store — the per-automation / per-agent classification
 * (AI Act Art. 5 prohibited practices, Art. 50 transparency, Annex III
 * high-risk). Append-only, modelled on dpiaStore: every attestation is a new
 * row, "current" = the newest row per target that has not expired.
 *
 *   signals  — what the platform detected itself (contains_ai, customer_facing,
 *              generates_content, disclosure_present, marking_enabled,
 *              annex_iii_hint, steps) — compliance/aiAct/signals.js
 *   answers  — what the admin answered ({art5, art50, annex_iii})
 *   outcome  — not_applicable | prohibited | high_risk | transparency | minimal
 *
 * An attestation expires after 12 months by default (`expires_at`), which is
 * what turns the AI-Act checks amber again once a year.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('AiActAssessmentStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_ai_act_assessments (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            target_kind TEXT NOT NULL,
            target_id TEXT NOT NULL,
            signals JSONB NOT NULL DEFAULT '{}'::jsonb,
            answers JSONB NOT NULL DEFAULT '{}'::jsonb,
            outcome TEXT NOT NULL,
            attested_by TEXT,
            attested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ai_act_assess_target ON compliance_ai_act_assessments(organization_id, target_kind, target_id, created_at DESC)`);
    // Who answered and what Bee found (automation/aiActAuto.js): source is
    // 'auto', 'mixed' or 'manual' from the automation's own page, NULL from the
    // hub and on rows from before; evidence holds the per-question findings.
    await exec(`ALTER TABLE compliance_ai_act_assessments ADD COLUMN IF NOT EXISTS source TEXT`);
    await exec(`ALTER TABLE compliance_ai_act_assessments ADD COLUMN IF NOT EXISTS evidence JSONB`);
}

const TARGET_KINDS = new Set(['automation', 'agent']);
const OUTCOMES = new Set(['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']);
/** Default validity of an attestation. */
const VALID_MONTHS = 12;

const ROW_COLUMNS = `id, organization_id, target_kind, target_id, signals, answers, outcome,
               attested_by, attested_at, expires_at, created_at, source, evidence`;
const SOURCES = new Set(['auto', 'mixed', 'manual']);

function _kind(kind) {
    if (!TARGET_KINDS.has(kind)) throw new Error(`invalid target_kind "${kind}"`);
    return kind;
}

function _plainObject(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; } }
    return {};
}

function _defaultExpiry(from) {
    const d = new Date(from.getTime());
    d.setUTCMonth(d.getUTCMonth() + VALID_MONTHS);
    return d;
}

/**
 * Append one assessment. `expiresAt` defaults to attested_at + 12 months;
 * pass `null` explicitly for an attestation that never expires (only
 * sensible for `not_applicable`).
 *
 * @param {string} orgId
 * @param {'automation'|'agent'} kind
 * @param {string} targetId
 * `source` ('auto' | 'mixed' | 'manual') and `evidence` (what Bee found)
 * come from the automation's own check; the hub passes neither.
 *
 * @param {{signals?:object, answers?:object, outcome?:string, attestedBy?:string|null, expiresAt?:Date|string|null, source?:string|null, evidence?:object|null}} [input]
 */
async function record(orgId, kind, targetId, { signals, answers, outcome, attestedBy, expiresAt, source = null, evidence = null } = {}) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    _kind(kind);
    if (targetId == null || String(targetId).trim() === '') throw new Error('target_id is required');
    if (!OUTCOMES.has(outcome)) throw new Error(`invalid outcome "${outcome}"`);
    const attestedAt = new Date();
    let expires;
    if (expiresAt === undefined) expires = _defaultExpiry(attestedAt);
    else if (expiresAt === null) expires = null;
    else {
        expires = new Date(expiresAt);
        if (Number.isNaN(expires.getTime())) throw new Error('expires_at is not a date');
    }
    const { rows } = await run(`
        INSERT INTO compliance_ai_act_assessments
            (organization_id, target_kind, target_id, signals, answers, outcome, attested_by, attested_at, expires_at, source, evidence)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb)
        RETURNING ${ROW_COLUMNS}
    `, [
        orgId,
        kind,
        String(targetId),
        JSON.stringify(_plainObject(signals)),
        JSON.stringify(_plainObject(answers)),
        outcome,
        attestedBy || null,
        attestedAt,
        expires,
        SOURCES.has(source) ? source : null,
        evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? JSON.stringify(evidence) : null,
    ]);
    return rows[0] || null;
}

async function getLatest(orgId, kind, targetId) {
    await initDB();
    _kind(kind);
    return getOne(`
        SELECT ${ROW_COLUMNS}
        FROM compliance_ai_act_assessments
        WHERE organization_id = $1 AND target_kind = $2 AND target_id = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `, [orgId, kind, String(targetId)]);
}

/** Newest row per (target_kind, target_id) — the register view. */
async function listForOrg(orgId) {
    await initDB();
    return getAll(`
        SELECT DISTINCT ON (target_kind, target_id)
            ${ROW_COLUMNS}
        FROM compliance_ai_act_assessments
        WHERE organization_id = $1
        ORDER BY target_kind, target_id, created_at DESC, id DESC
    `, [orgId]);
}

/** History for one target, newest first. */
async function listHistory(orgId, kind, targetId, { limit = 50 } = {}) {
    await initDB();
    _kind(kind);
    return getAll(`
        SELECT ${ROW_COLUMNS}
        FROM compliance_ai_act_assessments
        WHERE organization_id = $1 AND target_kind = $2 AND target_id = $3
        ORDER BY created_at DESC, id DESC
        LIMIT $4
    `, [orgId, kind, String(targetId), limit]);
}

/** An attestation counts while it has not expired (no expiry = evergreen). */
function isCurrent(row, now = Date.now()) {
    if (!row || !row.attested_at) return false;
    if (!row.expires_at) return true;
    return new Date(row.expires_at).getTime() > now;
}

/**
 * {attested, expired} over the newest row per target — the counts the hub
 * rail and the AI-Act checks show. Both are over DISTINCT targets.
 */
async function stats(orgId) {
    await initDB();
    const row = await getOne(`
        WITH latest AS (
            SELECT DISTINCT ON (target_kind, target_id) expires_at
            FROM compliance_ai_act_assessments
            WHERE organization_id = $1
            ORDER BY target_kind, target_id, created_at DESC, id DESC
        )
        SELECT
            COUNT(*) FILTER (WHERE expires_at IS NULL OR expires_at > NOW())::int AS attested,
            COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired
        FROM latest
    `, [orgId]);
    return row || { attested: 0, expired: 0 };
}

/** Newest-per-target rows whose attestation expires within `days` (or already did). */
async function listExpiring(orgId, days = 30) {
    await initDB();
    const d = Number.isFinite(Number(days)) && Number(days) >= 0 ? Math.floor(Number(days)) : 30;
    return getAll(`
        WITH latest AS (
            SELECT DISTINCT ON (target_kind, target_id) ${ROW_COLUMNS}
            FROM compliance_ai_act_assessments
            WHERE organization_id = $1
            ORDER BY target_kind, target_id, created_at DESC, id DESC
        )
        SELECT * FROM latest
        WHERE expires_at IS NOT NULL AND expires_at < NOW() + ($2 || ' days')::interval
        ORDER BY expires_at ASC
    `, [orgId, String(d)]);
}

module.exports = {
    initDB,
    record,
    getLatest,
    listForOrg,
    listHistory,
    isCurrent,
    stats,
    listExpiring,
    TARGET_KINDS: [...TARGET_KINDS],
    OUTCOMES: [...OUTCOMES],
    VALID_MONTHS,
};
