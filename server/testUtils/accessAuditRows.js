// @typecheck strict
'use strict';
/**
 * The access-audit table behind the REAL stores/userStore.logAccessAudit, for a
 * test of code that writes audit rows and must not need Postgres.
 *
 * The seam is the shared pool (testUtils/routeHarness.js recordDb): the store
 * runs its own code (id, `changedBy || 'system'`, JSON columns), and the row it
 * INSERTs is read back in the shape the call had:
 *
 *   const audit = useAccessAuditRows();            // BEFORE the first require
 *   const loginAudit = require('./loginAudit');
 *   test.beforeEach(audit.reset);
 *   ...
 *   assert.strictEqual(audit.rows[0].action, 'login_failed');
 *
 * `failOn(true)` makes the INSERT throw, as a missing table does.
 */

const { recordDb } = require('./routeHarness');

function useAccessAuditRows() {
    /** @type {Array<{ action: string, targetType: string, targetId: string, changedBy: string, oldValues: any, newValues: any, organizationId: string | null }>} */
    const rows = [];
    let failing = false;
    const db = recordDb((/** @type {string} */ sql, /** @type {any[]} */ params = []) => {
        if (!/^\s*INSERT INTO access_audit_log/i.test(sql)) return undefined;
        if (failing) throw new Error('audit table is gone');
        const [, action, targetType, targetId, organizationId, changedBy, oldValues, newValues] = params;
        rows.push({
            action, targetType, targetId, changedBy, organizationId,
            oldValues: oldValues ? JSON.parse(oldValues) : null,
            newValues: newValues ? JSON.parse(newValues) : null,
        });
        return { rows: [], rowCount: 1 };
    });
    return {
        rows,
        db,
        failOn(/** @type {boolean} */ on) { failing = on; },
        reset() { rows.length = 0; failing = false; db.reset(); },
    };
}

module.exports = { useAccessAuditRows };
