// @typecheck
/**
 * Canned responses — org-scoped reply templates (support_canned_responses);
 * a NULL organization_id row is system-wide and visible to every org.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');
const { buildUpdate } = require('../lib/sqlBuilder');

// ── Canned responses ─────────────────────────────────────────────────────────

async function listCannedResponses(organizationId = null) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_canned_responses
          WHERE organization_id IS NULL OR organization_id = $1
          ORDER BY title ASC`,
        [organizationId]
    );
    return rows;
}

async function getCannedResponse(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT * FROM support_canned_responses WHERE id = $1`, [id]);
    return rows[0] || null;
}

async function createCannedResponse({ organizationId = null, title, body, shortcut = null, createdBy = null }) {
    await initDB();
    if (!title || !title.trim()) throw new Error('title required');
    if (!body || !body.trim()) throw new Error('body required');
    const { rows } = await pool.query(
        `INSERT INTO support_canned_responses (organization_id, title, body, shortcut, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [organizationId, title.trim(), body, shortcut ? shortcut.trim() : null, createdBy]
    );
    return rows[0];
}

const CANNED_COLUMNS = {
    title: { col: 'title', transform: v => v.trim() },
    body: 'body',
    shortcut: { col: 'shortcut', transform: v => (v ? v.trim() : null) },
};

async function updateCannedResponse(id, { title, body, shortcut }, organizationId = null) {
    await initDB();
    const built = buildUpdate({
        table: 'support_canned_responses',
        updates: { title, body, shortcut },
        columnMap: CANNED_COLUMNS,
        extraSet: ['updated_at = now()'],
    });
    if (!built) return getCannedResponse(id);
    // IS NOT DISTINCT FROM, so a platform-wide response (organization_id NULL)
    // matches a null scope. The builder only models plain equality, so this
    // predicate stays here and its placeholders follow the SET clause.
    const params = built.params;
    params.push(id, organizationId);
    const { rows } = await pool.query(
        `${built.sql}
          WHERE id = $${params.length - 1} AND (organization_id IS NOT DISTINCT FROM $${params.length})
          RETURNING *`,
        params
    );
    return rows[0] || null;
}

async function deleteCannedResponse(id, organizationId = null) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM support_canned_responses
          WHERE id = $1 AND (organization_id IS NOT DISTINCT FROM $2)`,
        [id, organizationId]
    );
    return rowCount > 0;
}

module.exports = {
    listCannedResponses,
    getCannedResponse,
    createCannedResponse,
    updateCannedResponse,
    deleteCannedResponse,
};
