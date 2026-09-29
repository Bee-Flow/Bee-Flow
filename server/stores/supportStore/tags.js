// @typecheck
/**
 * Tags — the denormalised tag array on a thread, plus the org's tag taxonomy
 * (support_tag_taxonomy) that gives those strings a colour and a description.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');
const { getThread } = require('./threads');

// ── Tags & category ────────────────────────────────────────────────────────

/**
 * Replace a thread's tags. Normalises to lowercase, trims, dedupes, caps at 10.
 */
async function setThreadTags(threadId, tags = []) {
    await initDB();
    const clean = [...new Set(
        (Array.isArray(tags) ? tags : [])
            .map(t => String(t || '').trim())
            .filter(Boolean)
    )].slice(0, 10);
    const { rows } = await pool.query(
        `UPDATE support_threads SET tags = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
        [threadId, JSON.stringify(clean)]
    );
    return rows[0] || null;
}

/**
 * Add a single tag to a thread without removing existing ones (cap 10).
 */
async function addThreadTag(threadId, tag) {
    await initDB();
    const t = String(tag || '').trim();
    if (!t) return getThread(threadId);
    const thread = await getThread(threadId);
    if (!thread) return null;
    const existing = Array.isArray(thread.tags) ? thread.tags : [];
    return setThreadTags(threadId, [...existing, t]);
}

// ── Tag taxonomy CRUD ────────────────────────────────────────────────────────

async function listTags(organizationId = null) {
    await initDB();
    // Org-scoped tags plus system-wide (NULL org) tags.
    const { rows } = await pool.query(
        `SELECT * FROM support_tag_taxonomy
          WHERE organization_id IS NULL OR organization_id = $1
          ORDER BY LOWER(name) ASC`,
        [organizationId]
    );
    return rows;
}

async function createTag({ organizationId = null, name, color = null, description = null }) {
    await initDB();
    if (!name || !name.trim()) throw new Error('tag name required');
    const { rows } = await pool.query(
        `INSERT INTO support_tag_taxonomy (organization_id, name, color, description)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [organizationId, name.trim(), color, description]
    );
    return rows[0];
}

async function deleteTag(id, organizationId = null) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM support_tag_taxonomy
          WHERE id = $1 AND (organization_id IS NOT DISTINCT FROM $2)`,
        [id, organizationId]
    );
    return rowCount > 0;
}

module.exports = {
    setThreadTags,
    addThreadTag,
    listTags,
    createTag,
    deleteTag,
};
