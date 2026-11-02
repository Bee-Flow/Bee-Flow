// @typecheck strict
/**
 * Migration: strip default groups an organisation may not hand out (2026-11).
 *
 * `organizations."defaultGroups"` is applied to every new member of that
 * organisation. Before the write-side check existed the list could name a
 * group of another organisation, or a global group carrying the 'all'/'admin'
 * permission, a role or an orgRole. Every id that is not the organisation's own
 * group or a plain global group (auth/admin/defaultGroupFilter.mts, the same
 * rule the signup and SSO paths apply) is removed; the others keep their order.
 * Ids with no group behind them go too. A list that cannot be parsed is left
 * alone and counted.
 *
 * Idempotent: a cleaned list is unchanged by a second run. Skipped while either
 * table does not exist yet (a fresh database has no stored lists).
 */

'use strict';

const NAME = 'org-default-groups-cleanup-2026-11';

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{rows: Record<string, unknown>[], rowCount?: number}> }} Db */

/** @param {Db} db @param {string} table */
async function tableExists(db, table) {
    const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    return !!(rows[0] && rows[0].t);
}

/** @param {unknown} v @returns {unknown[] | null} */
function parseList(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined || v === '') return [];
    if (typeof v !== 'string') return null;
    try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * A group row as the filter reads it. Unreadable permissions or roles make a
 * global group count as not plain (it is kept only as an own-org group).
 * @param {Record<string, unknown>} row
 */
function groupFromRow(row) {
    const permissions = parseList(row.permissions);
    const roles = parseList(row.roles);
    return {
        id: row.id,
        organizationId: row.organizationId || null,
        permissions: permissions || [],
        roles: permissions && roles ? roles : ['unreadable'],
        orgRole: row.orgRole || '',
    };
}

/** @param {{ db?: Db }} [opts] */
async function up({ db } = {}) {
    const conn = db || /** @type {Db} */ ({ query: (sql, params) => require('../db').run(sql, params) });
    const result = { orgsChecked: 0, orgsUpdated: 0, idsRemoved: 0, unparseable: 0 };
    if (!(await tableExists(conn, 'organizations')) || !(await tableExists(conn, 'groups'))) {
        console.log(`[migration:${NAME}] tables not ready — skipping`);
        return result;
    }
    const { applicableDefaultGroups } = require('../auth/admin/defaultGroupFilter.mts');
    const groups = (await conn.query(`SELECT * FROM groups`)).rows.map(groupFromRow);
    const { rows } = await conn.query(`SELECT id, "defaultGroups" AS dg FROM organizations`);
    for (const row of rows) {
        result.orgsChecked++;
        const stored = parseList(row.dg);
        if (!stored) { result.unparseable++; continue; }
        const kept = applicableDefaultGroups(stored, groups, String(row.id));
        if (kept.length === stored.length && kept.every((g, i) => g === stored[i])) continue;
        await conn.query(`UPDATE organizations SET "defaultGroups" = $1 WHERE id = $2`, [JSON.stringify(kept), row.id]);
        result.orgsUpdated++;
        result.idsRemoved += stored.length - kept.length;
    }
    console.log(`[migration:${NAME}] ${JSON.stringify(result)}`);
    return result;
}

module.exports = { up, NAME };
