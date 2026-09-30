// @typecheck
/**
 * The colour a project gives one of its people, so they can be told apart at
 * a glance in the chat and on the tasks. One row per (project, person); no
 * row means "the automatic colour". It goes with the project, and a person
 * who leaves the project takes theirs with them.
 *
 * Built by a factory over a `{ query }` handle so the pg test runs the store's
 * own SQL against PGlite; the default instance wraps the pool.
 */

'use strict';

const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const DDL = `
    CREATE TABLE IF NOT EXISTS project_member_colors (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        color      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, user_id)
    );
`;

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} db
 * @param {{ ready?: () => Promise<any> }} [opts]
 */
function makeProjectMemberColorStore(db, { ready = async () => {} } = {}) {
    /** @returns {Promise<Record<string, string>>} user id → colour */
    async function listColors(projectId) {
        await ready();
        const r = await db.query('SELECT user_id, color FROM project_member_colors WHERE project_id = $1', [projectId]);
        return Object.fromEntries(r.rows.map((row) => [row.user_id, row.color]));
    }

    /** Give a person a colour, or take it away (null) so they go back to the automatic one. */
    async function setColor(projectId, userId, color) {
        await ready();
        if (!color) {
            await db.query('DELETE FROM project_member_colors WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
            return null;
        }
        await db.query(
            `INSERT INTO project_member_colors (project_id, user_id, color) VALUES ($1, $2, $3)
             ON CONFLICT (project_id, user_id) DO UPDATE SET color = EXCLUDED.color, updated_at = NOW()`,
            [projectId, userId, color],
        );
        return color;
    }

    /** A person left the project (or was removed): their colour goes. */
    async function clearFor(projectId, userId) {
        await ready();
        const r = await db.query('DELETE FROM project_member_colors WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
        return r.rowCount || 0;
    }

    return { listColors, setColor, clearFor };
}

const initDB = makeStoreInit('ProjectMemberColorStore', _initDB);

async function _initDB() {
    await require('./projectStore').initDB();
    await exec(DDL);
    log.info('[ProjectMemberColorStore] PostgreSQL initialized');
}

const defaultStore = makeProjectMemberColorStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = { initDB, DDL, makeProjectMemberColorStore, ...defaultStore };
