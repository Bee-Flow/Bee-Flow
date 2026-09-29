// @typecheck
/**
 * Playbooks — a phased AI build the user watches and consents to phase by
 * phase (Studio → Playbooks). One row per playbook; the phases (status,
 * brief, artifacts, summary) live in a JSONB column and every write goes
 * through `savePhases` with an optimistic version (the studioAppStore
 * saveDefinition shape), because the page PATCHes from several places (a
 * builder callback, the handoff card, a poll) and the last writer must never
 * silently win.
 *
 * Owner-only in v1: a playbook's artifacts are the owner's routine and app.
 */

'use strict';

const crypto = require('crypto');
const { getOne, getAll, run, getClient } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { parseJSONObject: parseJSON } = require('./lib/json');

const initDB = makeStoreInit('PlaybookStore', async () => {
    const res = await runDdl('playbookStore', [
        `CREATE TABLE IF NOT EXISTS playbooks (
            id              TEXT PRIMARY KEY,
            organization_id TEXT,
            user_id         TEXT NOT NULL,
            recipe_id       TEXT NOT NULL,
            title           TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'active',
            options         JSONB NOT NULL DEFAULT '{}'::jsonb,
            phases          JSONB NOT NULL DEFAULT '[]'::jsonb,
            current_phase   TEXT,
            version         INTEGER NOT NULL DEFAULT 1,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_playbooks_user ON playbooks(user_id, updated_at DESC)`,
        // The recipe DOCUMENT of a custom (AI-written) playbook; NULL for a built-in recipe.
        `ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS recipe JSONB`,
    ]);
    if (res.failures.length) {
        throw new Error(`playbooks DDL failed (${res.failures.map((f) => f.code).join(', ')}) — see the [DDL:playbookStore] lines`);
    }
});

function newPlaybookId() {
    return `pb_${crypto.randomBytes(6).toString('hex')}`;
}


function mapRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        organizationId: r.organization_id || null,
        userId: r.user_id,
        recipeId: r.recipe_id,
        recipe: parseJSON(r.recipe, null),
        title: r.title,
        status: r.status,
        options: parseJSON(r.options, {}),
        phases: parseJSON(r.phases, []),
        currentPhase: r.current_phase || null,
        version: parseInt(r.version, 10) || 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

async function createPlaybook({ userId, organizationId = null, recipeId, recipe = null, title, options = {}, phases = [], currentPhase = null }) {
    await initDB();
    const id = newPlaybookId();
    await run(
        `INSERT INTO playbooks (id, organization_id, user_id, recipe_id, recipe, title, status, options, phases, current_phase)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'active', $7::jsonb, $8::jsonb, $9)`,
        [id, organizationId, userId, recipeId, recipe ? JSON.stringify(recipe) : null, title, JSON.stringify(options || {}), JSON.stringify(phases || []), currentPhase],
    );
    return getPlaybook(id, userId);
}

async function getPlaybook(id, userId) {
    await initDB();
    if (!id || !userId) return null;
    const r = await getOne(`SELECT * FROM playbooks WHERE id = $1 AND user_id = $2`, [id, userId]);
    return mapRow(r);
}

async function listPlaybooksForUser(userId, { limit = 50 } = {}) {
    await initDB();
    if (!userId) return [];
    const rows = await getAll(`SELECT * FROM playbooks WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`, [userId, Math.max(1, Math.min(500, limit))]);
    return (rows || []).map(mapRow);
}

/**
 * The one write path for phases/status/title. `expectedVersion` (when given)
 * must equal the stored version or nothing is written and the caller gets
 * the current row back to rebase on.
 * @param id
 * @param userId
 * @param {{ phases?: any[], currentPhase?: string|number, status?: string, title?: string }} [opts]
 * @param {{ expectedVersion?: number|null }} [opts2]
 */
async function savePhases(id, userId, { phases, currentPhase, status, title } = {}, { expectedVersion = null } = {}) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(`SELECT * FROM playbooks WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId]);
        if (cur.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, notFound: true }; }
        const row = cur.rows[0];
        const currentVersion = parseInt(row.version, 10) || 1;
        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, currentVersion, playbook: mapRow(row) };
        }
        const nextVersion = currentVersion + 1;
        const nextPhases = Array.isArray(phases) ? phases : parseJSON(row.phases, []);
        await client.query(
            `UPDATE playbooks SET phases = $1::jsonb, current_phase = $2, status = $3, title = $4, version = $5, updated_at = NOW()
             WHERE id = $6 AND user_id = $7`,
            [
                JSON.stringify(nextPhases),
                currentPhase === undefined ? row.current_phase : currentPhase,
                status === undefined ? row.status : status,
                title === undefined ? row.title : title,
                nextVersion, id, userId,
            ],
        );
        await client.query('COMMIT');
        const saved = await getPlaybook(id, userId);
        return { ok: true, version: nextVersion, playbook: saved };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
    } finally {
        client.release();
    }
}

async function deletePlaybook(id, userId) {
    await initDB();
    const res = await run(`DELETE FROM playbooks WHERE id = $1 AND user_id = $2`, [id, userId]);
    const n = res && typeof res.rowCount === 'number' ? res.rowCount : (res && typeof /** @type {any} */ (res).changes === 'number' ? /** @type {any} */ (res).changes : 0);
    return n > 0;
}

module.exports = {
    // Started on access, not at module load — see boot/storeSchemas.js.
    get ready() { return initDB().catch(() => {}); },
    initDB,
    newPlaybookId,
    createPlaybook,
    getPlaybook,
    listPlaybooksForUser,
    savePhases,
    deletePlaybook,
    _test: { mapRow },
};
