// @typecheck
/**
 * ISO Audit Store — the ISMS process records the tool cannot automate:
 *   iso_audits             clause 9.2 internal-audit programme
 *   iso_audit_findings     what each audit observed (linked to Annex A refs)
 *   iso_management_reviews clause 9.3 reviews (inputs snapshot + human minutes)
 *   iso_nonconformities    clause 10 NC/CAPA lifecycle with effectiveness review
 *   iso_objectives         clause 6.2 measurable security objectives
 *
 * Human judgment stays human: status transitions and effectiveness
 * confirmations only STAMP who did what when — nothing here auto-approves,
 * auto-closes or auto-confirms. Same conventions as soaStore/incidentStore:
 * org-scoped, whitelisted fields, server-side timestamps.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('IsoAuditStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_audits (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            title TEXT NOT NULL,
            scope_note TEXT,
            auditor_user_id TEXT,
            status TEXT NOT NULL DEFAULT 'planned',
            planned_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_audit_findings (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            audit_id INT NOT NULL,
            control_ref TEXT,
            clause TEXT,
            severity TEXT NOT NULL DEFAULT 'observation',
            description TEXT NOT NULL,
            evidence_ref TEXT,
            nonconformity_id INT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_management_reviews (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            held_at TIMESTAMPTZ NOT NULL,
            attendees JSONB DEFAULT '[]'::jsonb,
            inputs JSONB DEFAULT '{}'::jsonb,
            decisions TEXT,
            minutes_evidence_ref TEXT,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_nonconformities (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            source TEXT NOT NULL DEFAULT 'manual',
            severity TEXT NOT NULL DEFAULT 'minor',
            status TEXT NOT NULL DEFAULT 'open',
            corrective_action TEXT,
            due_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,
            effectiveness_review_due_at TIMESTAMPTZ,
            effectiveness_confirmed_by TEXT,
            effectiveness_confirmed_at TIMESTAMPTZ,
            owner_user_id TEXT,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS iso_objectives (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            title TEXT NOT NULL,
            measure TEXT,
            target TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            review_due_at TIMESTAMPTZ,
            owner_user_id TEXT,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_audits_org ON iso_audits(organization_id, created_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_findings_org_audit ON iso_audit_findings(organization_id, audit_id, created_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_mr_org ON iso_management_reviews(organization_id, held_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_nc_org_status ON iso_nonconformities(organization_id, status, created_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_iso_obj_org ON iso_objectives(organization_id, created_at DESC)`);
}

const AUDIT_STATUSES = new Set(['planned', 'in_progress', 'closed']);
const FINDING_SEVERITIES = new Set(['observation', 'minor', 'major']);
const NC_SOURCES = new Set(['internal_audit', 'management_review', 'incident', 'check', 'manual']);
const NC_SEVERITIES = new Set(['minor', 'major']);
const NC_STATUSES = new Set(['open', 'corrective_action', 'effectiveness_review', 'closed']);
const OBJECTIVE_STATUSES = new Set(['active', 'achieved', 'dropped']);

// ---------------------------------------------------------------- 9.2 audits

async function listAudits(orgId) {
    await initDB();
    return getAll(`
        SELECT * FROM iso_audits
        WHERE organization_id = $1
        ORDER BY created_at DESC
    `, [orgId]);
}

async function getAudit(orgId, id) {
    await initDB();
    return getOne(`SELECT * FROM iso_audits WHERE organization_id = $1 AND id = $2`, [orgId, id]);
}

async function createAudit(orgId, input, actorId = null) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    if (!input?.title) throw new Error('title is required');
    const { rows } = await run(`
        INSERT INTO iso_audits
            (organization_id, title, scope_note, auditor_user_id, status, planned_at, created_by)
        VALUES ($1, $2, $3, $4, 'planned', $5, $6)
        RETURNING *
    `, [
        orgId,
        String(input.title).slice(0, 300),
        input.scope_note || null,
        input.auditor_user_id || null,
        input.planned_at || null,
        actorId,
    ]);
    return rows?.[0];
}

/**
 * Whitelisted partial update. Status transitions stamp server-side:
 *   status=in_progress → started_at (first time only)
 *   status=closed      → closed_at  (first time only)
 */
async function updateAudit(orgId, id, patch = {}) {
    await initDB();
    const existing = await getAudit(orgId, id);
    if (!existing) return null;
    const status = AUDIT_STATUSES.has(patch.status) ? patch.status : existing.status;
    await run(`
        UPDATE iso_audits SET
            title = COALESCE($3, title),
            scope_note = COALESCE($4, scope_note),
            auditor_user_id = COALESCE($5, auditor_user_id),
            planned_at = COALESCE($6, planned_at),
            status = $7,
            started_at = CASE WHEN $7 = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END,
            closed_at = CASE WHEN $7 = 'closed' AND closed_at IS NULL THEN NOW() ELSE closed_at END
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, id,
        patch.title ? String(patch.title).slice(0, 300) : null,
        patch.scope_note !== undefined ? (patch.scope_note || null) : null,
        patch.auditor_user_id || null,
        patch.planned_at || null,
        status,
    ]);
    return getAudit(orgId, id);
}

// ------------------------------------------------------------ audit findings

async function listFindings(orgId, auditId = null) {
    await initDB();
    if (auditId != null) {
        return getAll(`
            SELECT * FROM iso_audit_findings
            WHERE organization_id = $1 AND audit_id = $2
            ORDER BY created_at DESC
        `, [orgId, auditId]);
    }
    return getAll(`
        SELECT * FROM iso_audit_findings
        WHERE organization_id = $1
        ORDER BY created_at DESC
    `, [orgId]);
}

async function addFinding(orgId, auditId, input) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    if (!auditId) throw new Error('audit_id is required');
    if (!input?.description) throw new Error('description is required');
    const severity = FINDING_SEVERITIES.has(input.severity) ? input.severity : 'observation';
    const { rows } = await run(`
        INSERT INTO iso_audit_findings
            (organization_id, audit_id, control_ref, clause, severity, description,
             evidence_ref, nonconformity_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
    `, [
        orgId,
        auditId,
        input.control_ref || null,
        input.clause || null,
        severity,
        String(input.description).slice(0, 4000),
        input.evidence_ref || null,
        input.nonconformity_id || null,
    ]);
    return rows?.[0];
}

// --------------------------------------------------- 9.3 management reviews

async function listReviews(orgId) {
    await initDB();
    return getAll(`
        SELECT * FROM iso_management_reviews
        WHERE organization_id = $1
        ORDER BY held_at DESC
    `, [orgId]);
}

/**
 * Records one held management review. `inputs` is the 9.3.2 agenda snapshot
 * the route auto-built (score trend, incidents, NCs, audit results…);
 * `decisions` are the HUMAN minutes — never generated here.
 */
async function createReview(orgId, input, actorId = null) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    if (!input?.held_at) throw new Error('held_at is required');
    const attendees = Array.isArray(input.attendees) ? input.attendees : [];
    const inputsSnapshot = (input.inputs && typeof input.inputs === 'object') ? input.inputs : {};
    const { rows } = await run(`
        INSERT INTO iso_management_reviews
            (organization_id, held_at, attendees, inputs, decisions, minutes_evidence_ref, created_by)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
        RETURNING *
    `, [
        orgId,
        input.held_at,
        JSON.stringify(attendees),
        JSON.stringify(inputsSnapshot),
        input.decisions || null,
        input.minutes_evidence_ref || null,
        actorId,
    ]);
    return rows?.[0];
}

// ------------------------------------------------------- 10 NC / CAPA

/**
 * @param orgId
 * @param {{ status?: string }} [opts]
 */
async function listNonconformities(orgId, { status } = {}) {
    await initDB();
    const params = [orgId];
    let where = 'organization_id = $1';
    if (status && NC_STATUSES.has(status)) { params.push(status); where += ` AND status = $${params.length}`; }
    return getAll(`
        SELECT * FROM iso_nonconformities
        WHERE ${where}
        ORDER BY created_at DESC
    `, params);
}

async function getNonconformity(orgId, id) {
    await initDB();
    return getOne(`SELECT * FROM iso_nonconformities WHERE organization_id = $1 AND id = $2`, [orgId, id]);
}

async function createNonconformity(orgId, input, actorId = null) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    if (!input?.title) throw new Error('title is required');
    const source = NC_SOURCES.has(input.source) ? input.source : 'manual';
    const severity = NC_SEVERITIES.has(input.severity) ? input.severity : 'minor';
    const { rows } = await run(`
        INSERT INTO iso_nonconformities
            (organization_id, title, description, source, severity, status,
             corrective_action, due_at, owner_user_id, created_by)
        VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9)
        RETURNING *
    `, [
        orgId,
        String(input.title).slice(0, 300),
        input.description || null,
        source,
        severity,
        input.corrective_action || null,
        input.due_at || null,
        input.owner_user_id || null,
        actorId,
    ]);
    return rows?.[0];
}

/**
 * Whitelisted partial update. Server-side stamps, never client-supplied:
 *   status=closed                → closed_at (first time only)
 *   patch.confirm_effectiveness  → effectiveness_confirmed_by/_at = actor/NOW()
 *                                  (first time only — a human pressed confirm)
 */
async function updateNonconformity(orgId, id, patch = {}, actorId = null) {
    await initDB();
    const existing = await getNonconformity(orgId, id);
    if (!existing) return null;
    const status = NC_STATUSES.has(patch.status) ? patch.status : existing.status;
    const confirmEffectiveness = patch.confirm_effectiveness === true;
    await run(`
        UPDATE iso_nonconformities SET
            title = COALESCE($3, title),
            description = COALESCE($4, description),
            severity = COALESCE($5, severity),
            corrective_action = COALESCE($6, corrective_action),
            due_at = COALESCE($7, due_at),
            effectiveness_review_due_at = COALESCE($8, effectiveness_review_due_at),
            owner_user_id = COALESCE($9, owner_user_id),
            status = $10,
            closed_at = CASE WHEN $10 = 'closed' AND closed_at IS NULL THEN NOW() ELSE closed_at END,
            effectiveness_confirmed_by = CASE WHEN $11 AND effectiveness_confirmed_by IS NULL THEN $12 ELSE effectiveness_confirmed_by END,
            effectiveness_confirmed_at = CASE WHEN $11 AND effectiveness_confirmed_at IS NULL THEN NOW() ELSE effectiveness_confirmed_at END,
            updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, id,
        patch.title ? String(patch.title).slice(0, 300) : null,
        patch.description !== undefined ? (patch.description || null) : null,
        NC_SEVERITIES.has(patch.severity) ? patch.severity : null,
        patch.corrective_action !== undefined ? (patch.corrective_action || null) : null,
        patch.due_at || null,
        patch.effectiveness_review_due_at || null,
        patch.owner_user_id || null,
        status,
        confirmEffectiveness,
        actorId,
    ]);
    return getNonconformity(orgId, id);
}

// ----------------------------------------------------------- 6.2 objectives

async function listObjectives(orgId) {
    await initDB();
    return getAll(`
        SELECT * FROM iso_objectives
        WHERE organization_id = $1
        ORDER BY created_at DESC
    `, [orgId]);
}

async function getObjective(orgId, id) {
    await initDB();
    return getOne(`SELECT * FROM iso_objectives WHERE organization_id = $1 AND id = $2`, [orgId, id]);
}

async function createObjective(orgId, input, actorId = null) {
    await initDB();
    if (!orgId) throw new Error('organization_id is required');
    if (!input?.title) throw new Error('title is required');
    const { rows } = await run(`
        INSERT INTO iso_objectives
            (organization_id, title, measure, target, status, review_due_at, owner_user_id, created_by)
        VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
        RETURNING *
    `, [
        orgId,
        String(input.title).slice(0, 300),
        input.measure || null,
        input.target || null,
        input.review_due_at || null,
        input.owner_user_id || null,
        actorId,
    ]);
    return rows?.[0];
}

async function updateObjective(orgId, id, patch = {}) {
    await initDB();
    const existing = await getObjective(orgId, id);
    if (!existing) return null;
    const status = OBJECTIVE_STATUSES.has(patch.status) ? patch.status : existing.status;
    await run(`
        UPDATE iso_objectives SET
            title = COALESCE($3, title),
            measure = COALESCE($4, measure),
            target = COALESCE($5, target),
            status = $6,
            review_due_at = COALESCE($7, review_due_at),
            owner_user_id = COALESCE($8, owner_user_id),
            updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
    `, [
        orgId, id,
        patch.title ? String(patch.title).slice(0, 300) : null,
        patch.measure !== undefined ? (patch.measure || null) : null,
        patch.target !== undefined ? (patch.target || null) : null,
        status,
        patch.review_due_at || null,
        patch.owner_user_id || null,
    ]);
    return getObjective(orgId, id);
}

module.exports = {
    initDB,
    listAudits,
    createAudit,
    updateAudit,
    listFindings,
    addFinding,
    listReviews,
    createReview,
    listNonconformities,
    createNonconformity,
    updateNonconformity,
    listObjectives,
    createObjective,
    updateObjective,
};
