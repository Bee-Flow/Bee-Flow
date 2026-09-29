// @typecheck
/**
 * Risk Store — ISO 27001 clause 6.1.2/6.1.3 information-security risk register.
 *
 * One row per risk per org: likelihood × impact (both 1–5) → score (1–25),
 * computed HERE so the number on file is always consistent with its factors.
 * Treatments live in a child table (mitigate/transfer/avoid/accept), each
 * with its own owner and due date.
 *
 * Accepting a risk is a management DECISION: status → 'accepted' stamps
 * accepted_by/accepted_at server-side from the acting user — never from the
 * client, never automatically.
 *
 * Seeded scenarios (`source = 'seed'`) dedupe on `seed_key` via a partial
 * unique index, so re-seeding never duplicates and never overwrites edits.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('RiskStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_risks (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT,
            likelihood INT NOT NULL DEFAULT 3,
            impact INT NOT NULL DEFAULT 3,
            score INT NOT NULL DEFAULT 9,
            status TEXT NOT NULL DEFAULT 'open',
            owner_user_id TEXT,
            source TEXT NOT NULL DEFAULT 'manual',
            seed_key TEXT,
            accepted_by TEXT,
            accepted_at TIMESTAMPTZ,
            review_due_at TIMESTAMPTZ,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_risk_treatments (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            risk_id INT NOT NULL,
            option TEXT NOT NULL DEFAULT 'mitigate',
            description TEXT,
            due_at TIMESTAMPTZ,
            done_at TIMESTAMPTZ,
            owner_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_risks_org_status ON iso_risks(organization_id, status, score DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_risk_treatments_org ON iso_risk_treatments(organization_id, risk_id)`);
    // Partial unique index: the ON CONFLICT target for seedMissing.
    await exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_iso_risks_org_seed_key
        ON iso_risks(organization_id, seed_key) WHERE seed_key IS NOT NULL
    `);
}

const VALID_STATUSES = new Set(['open', 'treating', 'accepted', 'closed']);
const VALID_OPTIONS = new Set(['mitigate', 'transfer', 'avoid', 'accept']);
// 'playbook' — a risk a playbook's closing compliance review raised, kept
// apart from 'manual' so the register can say where a row came from.
const VALID_SOURCES = new Set(['manual', 'seed', 'playbook']);
const HIGH_SCORE = 10;

/** Clamp a likelihood/impact value to the 1–5 scale; null when not a number. */
function clampScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(5, Math.max(1, Math.round(n)));
}

async function listRisks(orgId) {
    await initDB();
    return getAll(`
        SELECT * FROM iso_risks
        WHERE organization_id = $1
        ORDER BY score DESC, created_at DESC
    `, [orgId]);
}

/** All treatments for the org — the route zips them onto listRisks by risk_id. */
async function listTreatments(orgId) {
    await initDB();
    return getAll(`
        SELECT * FROM iso_risk_treatments
        WHERE organization_id = $1
        ORDER BY created_at ASC
    `, [orgId]);
}

async function getRisk(orgId, id) {
    await initDB();
    return getOne(`SELECT * FROM iso_risks WHERE organization_id = $1 AND id = $2`, [orgId, id]);
}

/**
 * Create one risk. Only whitelisted fields are read from `fields`; the score
 * is always recomputed here (likelihood × impact), never taken from input.
 */
async function createRisk(orgId, fields = {}, actorId = null) {
    await initDB();
    if (!orgId) throw new Error('orgId is required');
    if (!fields.title) throw new Error('title is required');
    const likelihood = clampScale(fields.likelihood) ?? 3;
    const impact = clampScale(fields.impact) ?? 3;
    const { rows } = await run(`
        INSERT INTO iso_risks
            (organization_id, title, description, category, likelihood, impact, score,
             status, owner_user_id, source, seed_key, review_due_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
    `, [
        orgId,
        String(fields.title).slice(0, 300),
        fields.description || null,
        fields.category || null,
        likelihood,
        impact,
        likelihood * impact,
        VALID_STATUSES.has(fields.status) ? fields.status : 'open',
        fields.owner_user_id || null,
        VALID_SOURCES.has(fields.source) ? fields.source : 'manual',
        fields.seed_key || null,
        fields.review_due_at || null,
        actorId,
    ]);
    return rows?.[0] || null;
}

/**
 * Partial update — whitelist only, everything else in `patch` is silently
 * dropped. Score is recomputed whenever likelihood/impact change. A status
 * transition to 'accepted' stamps accepted_by/accepted_at from the ACTOR
 * (human decision on record); existing stamps are never overwritten.
 */
async function updateRisk(orgId, id, patch = {}, actorId = null) {
    await initDB();
    const existing = await getRisk(orgId, id);
    if (!existing) return null;

    const likelihood = clampScale(patch.likelihood) ?? clampScale(existing.likelihood) ?? 3;
    const impact = clampScale(patch.impact) ?? clampScale(existing.impact) ?? 3;
    const status = VALID_STATUSES.has(patch.status) ? patch.status : existing.status;
    const stampAcceptance = status === 'accepted' && !existing.accepted_at;

    await run(`
        UPDATE iso_risks SET
            title = $3,
            description = $4,
            category = $5,
            likelihood = $6,
            impact = $7,
            score = $8,
            status = $9,
            owner_user_id = $10,
            review_due_at = $11,
            accepted_by = CASE WHEN $12 THEN $13 ELSE accepted_by END,
            accepted_at = CASE WHEN $12 THEN NOW() ELSE accepted_at END,
            updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, id,
        patch.title !== undefined ? String(patch.title).slice(0, 300) : existing.title,
        patch.description !== undefined ? (patch.description || null) : (existing.description ?? null),
        patch.category !== undefined ? (patch.category || null) : (existing.category ?? null),
        likelihood,
        impact,
        likelihood * impact,
        status,
        patch.owner_user_id !== undefined ? (patch.owner_user_id || null) : (existing.owner_user_id ?? null),
        patch.review_due_at !== undefined ? (patch.review_due_at || null) : (existing.review_due_at ?? null),
        stampAcceptance,
        actorId,
    ]);
    return getRisk(orgId, id);
}

/** Add one treatment to a risk. Unknown options fall back to 'mitigate'. */
async function addTreatment(orgId, riskId, fields = {}, actorId = null) {
    await initDB();
    if (!orgId) throw new Error('orgId is required');
    if (!riskId) throw new Error('riskId is required');
    const { rows } = await run(`
        INSERT INTO iso_risk_treatments
            (organization_id, risk_id, option, description, due_at, owner_user_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
    `, [
        orgId,
        riskId,
        VALID_OPTIONS.has(fields.option) ? fields.option : 'mitigate',
        fields.description || null,
        fields.due_at || null,
        fields.owner_user_id || actorId || null,
    ]);
    return rows?.[0] || null;
}

/** Partial treatment update — whitelist only (option/description/due/done/owner). */
async function updateTreatment(orgId, id, patch = {}) {
    await initDB();
    const existing = await getOne(`
        SELECT * FROM iso_risk_treatments WHERE organization_id = $1 AND id = $2
    `, [orgId, id]);
    if (!existing) return null;
    await run(`
        UPDATE iso_risk_treatments SET
            option = $3,
            description = $4,
            due_at = $5,
            done_at = $6,
            owner_user_id = $7
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, id,
        VALID_OPTIONS.has(patch.option) ? patch.option : existing.option,
        patch.description !== undefined ? (patch.description || null) : (existing.description ?? null),
        patch.due_at !== undefined ? (patch.due_at || null) : (existing.due_at ?? null),
        patch.done_at !== undefined ? (patch.done_at || null) : (existing.done_at ?? null),
        patch.owner_user_id !== undefined ? (patch.owner_user_id || null) : (existing.owner_user_id ?? null),
    ]);
    return getOne(`SELECT * FROM iso_risk_treatments WHERE organization_id = $1 AND id = $2`, [orgId, id]);
}

/**
 * Seed suggested risk scenarios — INSERT only where `seed_key` is not present
 * yet (conflict target = the partial unique index from initDB); existing rows,
 * including ones the admin edited, are never touched. `seeds` is
 * [{ seed_key, title, description, category, likelihood, impact }];
 * returns how many rows were actually inserted.
 */
async function seedMissing(orgId, seeds) {
    await initDB();
    let inserted = 0;
    for (const s of seeds || []) {
        if (!s?.seed_key || !s?.title) continue;
        const likelihood = clampScale(s.likelihood) ?? 3;
        const impact = clampScale(s.impact) ?? 3;
        const r = await run(`
            INSERT INTO iso_risks
                (organization_id, title, description, category, likelihood, impact, score,
                 status, source, seed_key)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', 'seed', $8)
            ON CONFLICT (organization_id, seed_key) WHERE seed_key IS NOT NULL DO NOTHING
        `, [
            orgId,
            String(s.title).slice(0, 300),
            s.description || null,
            s.category || null,
            likelihood,
            impact,
            likelihood * impact,
            s.seed_key,
        ]);
        if (r?.rowCount) inserted += r.rowCount;
    }
    return inserted;
}

/**
 * Counters for the readiness dashboard. `high` = active risks in the orange/
 * red band (score >= 10); `overdue_reviews` = active risks past review_due_at.
 * Closed risks drop out of both operational counters.
 */
async function getStats(orgId) {
    await initDB();
    const row = await getOne(`
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE status = 'treating')::int AS treating,
            COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
            COUNT(*) FILTER (WHERE score >= $2 AND status <> 'closed')::int AS high,
            COUNT(*) FILTER (
                WHERE review_due_at IS NOT NULL AND review_due_at < NOW() AND status <> 'closed'
            )::int AS overdue_reviews
        FROM iso_risks
        WHERE organization_id = $1
    `, [orgId, HIGH_SCORE]);
    return row || { total: 0, open: 0, treating: 0, accepted: 0, closed: 0, high: 0, overdue_reviews: 0 };
}

module.exports = {
    initDB,
    listRisks,
    listTreatments,
    getRisk,
    createRisk,
    updateRisk,
    addTreatment,
    updateTreatment,
    seedMissing,
    getStats,
    HIGH_SCORE,
};
