// @typecheck strict
/**
 * DPIA Store — Data Protection Impact Assessment per agent (GDPR Art. 35).
 *
 * Two modes per agent (user choice):
 *   - 'attestation'   admin checks a box, captures who/when/expires_at.
 *   - 'questionnaire' structured answers JSON (data categories, automated
 *                     decision-making, mitigations).
 *
 * Art-35 compliance check is `per-source` scope: subjects = published agents
 * flagged high-risk; pass iff an unexpired DPIA row exists.
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('DpiaStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS dpia_assessments (
            id SERIAL PRIMARY KEY,
            organization_id TEXT,
            agent_id TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'attestation',
            risk_level TEXT,
            answers JSONB DEFAULT '{}'::jsonb,
            mitigations JSONB DEFAULT '[]'::jsonb,
            approved_by TEXT,
            approved_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_dpia_org_agent ON dpia_assessments(organization_id, agent_id, created_at DESC)`);
}

const VALID_MODES = new Set(['attestation', 'questionnaire']);

/**
 * @param {string|null} orgId
 * @param {string|number} agentId
 * @param {{ mode?: string, risk_level?: string, expires_at?: string|Date|null, answers?: object, mitigations?: unknown[], approved_by?: string|null } | null} [input]
 */
async function upsertAssessment(orgId, agentId, input) {
    await initDB();
    const mode = typeof input?.mode === 'string' && VALID_MODES.has(input.mode) ? input.mode : 'attestation';
    const riskLevel = input?.risk_level || 'medium';
    const expiresAt = input?.expires_at || null;
    const answersJson = JSON.stringify(input?.answers || {});
    const mitigationsJson = JSON.stringify(input?.mitigations || []);
    await run(`
        INSERT INTO dpia_assessments
            (organization_id, agent_id, mode, risk_level, answers, mitigations,
             approved_by, approved_at, expires_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NOW(), $8)
    `, [
        orgId || null,
        String(agentId),
        mode,
        riskLevel,
        answersJson,
        mitigationsJson,
        input?.approved_by || null,
        expiresAt,
    ]);
    return getLatestForAgent(orgId, agentId);
}

/**
 * @param {string|null} orgId
 * @param {string|number} agentId
 */
async function getLatestForAgent(orgId, agentId) {
    await initDB();
    return getOne(`
        SELECT * FROM dpia_assessments
        WHERE organization_id = $1 AND agent_id = $2
        ORDER BY created_at DESC
        LIMIT 1
    `, [orgId, agentId]);
}

/** @param {string|null} orgId */
async function listForOrg(orgId) {
    await initDB();
    return getAll(`
        SELECT DISTINCT ON (agent_id)
            id, agent_id, mode, risk_level, approved_by, approved_at, expires_at, created_at
        FROM dpia_assessments
        WHERE organization_id = $1
        ORDER BY agent_id, created_at DESC
    `, [orgId]);
}

/**
 * The latest assessment per subject with a readable title (the agent's name when it is an agent).
 * @param {string|null} orgId
 */
async function listForOrgNamed(orgId) {
    await initDB();
    // A missing agents table (a bare test database) only costs the readable title.
    return getAll(`
        SELECT DISTINCT ON (d.agent_id)
            d.id, d.agent_id, COALESCE(a.name, d.agent_id) AS title, d.approved_at, d.expires_at, d.created_at
        FROM dpia_assessments d LEFT JOIN agents a ON a.id::text = d.agent_id
        WHERE d.organization_id = $1
        ORDER BY d.agent_id, d.created_at DESC
    `, [orgId]).catch(() => listForOrg(orgId));
}

/**
 * One assessment by its id, only when it belongs to the organisation.
 * @param {string|null} orgId
 * @param {string|number} id
 */
async function getByIdForOrg(orgId, id) {
    await initDB();
    if (!orgId || !/^\d{1,9}$/.test(String(id))) return null;
    return getOne(`
        SELECT id, agent_id, mode, risk_level, approved_by, approved_at, expires_at, created_at
        FROM dpia_assessments WHERE id = $1 AND organization_id = $2
    `, [Number(id), orgId]);
}

/** @param {import('pg').QueryResultRow | null | undefined} row */
function isCurrent(row) {
    if (!row || !row.approved_at) return false;
    if (!row.expires_at) return true;
    return new Date(row.expires_at).getTime() > Date.now();
}

module.exports = {
    initDB,
    upsertAssessment,
    getLatestForAgent,
    listForOrg,
    getByIdForOrg,
    listForOrgNamed,
    isCurrent,
};
