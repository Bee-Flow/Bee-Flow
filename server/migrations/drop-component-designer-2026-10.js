// @typecheck noImplicitAny
/**
 * Migration: the Component Designer is gone (2026-10).
 *
 * The Component Studio, its AI designer chat and the routes that wrote
 * component code onto the server were removed; the shipped components in
 * components/ stay. What the database still carries of the feature:
 *
 *   1. `organizations.org_granted_capabilities`: "component_designer" in the
 *      JSON list of every org that had it (it was in the column DEFAULT, so
 *      that is nearly every org). The id is no longer in the capability
 *      registry; it is removed from each list, and every other id stays in
 *      its place. A list that cannot be parsed is left alone.
 *   2. The column DEFAULT still names it on an existing database (the
 *      `ADD COLUMN IF NOT EXISTS` in stores/user/schema.js only sets the
 *      default on a fresh one), so new orgs would keep getting it. The
 *      DEFAULT becomes '["notebooks","projects"]', same as schema.js.
 *   3. The `system-component-designer` system agent row (owner 'system', no
 *      user data). Its agent_tools and other child rows go with it (ON DELETE
 *      CASCADE). The seeder no longer creates it (stores/agent/systemAgentRegistry.js).
 *
 * Idempotent: every step matches only what is still there. Skipped per table
 * when the table does not exist yet (a fresh database seeds without the id).
 */

'use strict';

const log = require('../telemetry/log');

const NAME = 'drop-component-designer-2026-10';
const CAPABILITY = 'component_designer';
const AGENT_ID = 'system-component-designer';
const NEW_DEFAULT = '["notebooks","projects"]';

/** @typedef {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} Db */

/** @param {Db} db @param {string} table */
async function tableExists(db, table) {
    const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    return !!(rows[0] && rows[0].t);
}

/** @param {Db} db @param {string} table @param {string} column */
async function columnExists(db, table, column) {
    const { rows } = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]);
    return rows.length > 0;
}

/** @param {unknown} text @returns {unknown[] | null} */
function parseList(text) {
    if (typeof text !== 'string') return null;
    try {
        const v = JSON.parse(text);
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

/** @param {Db} db */
async function dropGrant(db) {
    const { rows } = await db.query(
        `SELECT id, "org_granted_capabilities" AS caps FROM organizations WHERE "org_granted_capabilities" LIKE $1`,
        [`%"${CAPABILITY}"%`]);
    let updated = 0;
    for (const row of rows) {
        const list = parseList(row.caps);
        if (!list || !list.includes(CAPABILITY)) continue;
        await db.query(`UPDATE organizations SET "org_granted_capabilities" = $1 WHERE id = $2`,
            [JSON.stringify(list.filter((id) => id !== CAPABILITY)), row.id]);
        updated++;
    }
    await db.query(`ALTER TABLE organizations ALTER COLUMN "org_granted_capabilities" SET DEFAULT '${NEW_DEFAULT}'`);
    return updated;
}

/** @param {{ db?: Db }} [opts] */
async function up({ db } = {}) {
    const conn = db || { query: (sql, params) => require('../db').run(sql, params) };
    /** @type {{ orgsUpdated: number | null, agentDeleted: boolean | null }} */
    const result = { orgsUpdated: null, agentDeleted: null };
    if (await tableExists(conn, 'organizations') && await columnExists(conn, 'organizations', 'org_granted_capabilities')) {
        result.orgsUpdated = await dropGrant(conn);
    }
    if (await tableExists(conn, 'agents')) {
        const res = await conn.query(`DELETE FROM agents WHERE id = $1`, [AGENT_ID]);
        result.agentDeleted = (res.rowCount || 0) > 0;
    }
    log.info(`[Migration] ${NAME} applied`, JSON.stringify(result));
    return result;
}

module.exports = { up, NAME };
