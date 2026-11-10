// @typecheck strict
'use strict';
/**
 * Shared set-up for the Studio app data route tests: the require-cache stub
 * helper, the in-memory SQLite `tasks` engine, faithful copies of the store's
 * pure access predicates and the base data model the tests start from.
 */
/** @typedef {{ userId: string, isPublished?: boolean, organizationId?: string | null, sharedGroups?: string[] }} StudioAppRow */

/** @param {string} path @param {Record<string, unknown>} exports */
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

/** @param {unknown[] | undefined} params */
function norm(params) { return (params || []).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)); }

/** @param {StudioAppRow | null | undefined} app @param {string} userId @param {string[]} [userGroupIds] @param {Iterable<string> | null} [userOrgIds] */
function canReadStudioApp(app, userId, userGroupIds = [], userOrgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished) return false;
    if (!app.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(app.organizationId)) return false;
    const groups = Array.isArray(app.sharedGroups) ? app.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some((g) => userGroupIds.includes(g));
}

/** @param {StudioAppRow | null | undefined} app @param {string} userId */
function canWriteStudioApp(app, userId) { return !!app && app.userId === userId; }

/** @returns {Record<string, unknown>} */
function baseModel() {
    return {
        modelVersion: 1,
        roles: [{ key: 'manager' }, { key: 'member' }],
        roleMapping: { default: 'member', byGroup: {} },
        tables: [{
            id: 'tbl_tasks0', key: 'tasks', name: 'Tasks',
            fields: [
                { id: 'fld_title', key: 'title', type: 'text' },
                { id: 'fld_region', key: 'region', type: 'text' },
                { id: 'fld_amount', key: 'amount', type: 'number', subtype: 'integer' },
            ],
            access: {
                default: 'none',
                roles: {
                    manager: { read: 'all', create: true, update: 'all', delete: 'all' },
                    member: { read: 'own', create: true, update: 'own', delete: 'none' },
                },
                rowFilters: {},
            },
        }],
    };
}

/**
 * @param {import('better-sqlite3').Database} memdb
 * @param {string} org
 * @param {{ id: string, by: string, region?: string, amount?: number, title?: string }} row
 */
function insertTaskRow(memdb, org, { id, by, region = 'EU', amount = 10, title = 'T' }) {
    memdb.prepare(`INSERT INTO tasks (id, created_at, updated_at, created_by, org_id, title, region, amount)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', by, org, title, region, amount);
}

module.exports = { insertTaskRow, stub, norm, canReadStudioApp, canWriteStudioApp, baseModel };
