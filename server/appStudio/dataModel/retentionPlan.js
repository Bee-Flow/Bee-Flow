// @typecheck
/**
 * The retention plan: how a purge reaches every table a connector writes.
 *
 * PURE and dependency-free, so both the connector-save gate
 * (dataModel/connectorValidate) and the purge (connectorSync) can use it
 * without requiring each other. Extracted from connectorSync.js unchanged.
 */

'use strict';

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The COLUMN on `table` that holds the incremental stamp.
 *
 * The sync's `incremental.field` names a path in the UPSTREAM row, which is not
 * necessarily what the column ended up being called. Matching sourcePath first
 * (then key, for tables whose columns simply share the name) is what lets the
 * retention purge find the right column on both the parent and its children.
 */
function retentionColumn(table, sourceField) {
    const fields = (table && table.fields) || [];
    const bySource = fields.find((f) => f && f.sourcePath === sourceField);
    if (bySource) return bySource.key;
    const byKey = fields.find((f) => f && f.key === sourceField);
    return byKey ? byKey.key : null;
}

// A retention cutoff is a string comparison against a stored stamp. Only these
// hold one; deleting rows by comparing a number or a bool to an ISO timestamp
// would be arbitrary, so a table whose candidate column is anything else counts
// as unreachable rather than as covered.
const RETENTION_COLUMN_TYPES = ['datetime', 'date', 'text'];

function datedColumn(table, declared, sourceField) {
    const fields = (table && table.fields) || [];
    // A DECLARED retentionField must exist on this table; falling back to the
    // sync's stamp when it doesn't would hide the author's typo behind a column
    // they never chose.
    const key = (typeof declared === 'string' && declared)
        ? (fields.some((f) => f && f.key === declared) ? declared : null)
        : (sourceField ? retentionColumn(table, sourceField) : null);
    if (!key) return null;
    const field = fields.find((f) => f && f.key === key);
    return field && RETENTION_COLUMN_TYPES.includes(field.type) ? key : null;
}

// A DEPENDENT's date column. Stricter than a child's: the connector never
// writes these rows, so there is no sync stamp to fall back to and no control
// over what a text column holds — the declared column must exist and be a real
// date. Comparing an ISO cutoff to arbitrary app-typed text would purge on
// string luck.
const DEPENDENT_RETENTION_COLUMN_TYPES = ['datetime', 'date'];

function dependentDatedColumn(table, declared) {
    if (typeof declared !== 'string' || !declared) return null;
    const field = ((table && table.fields) || []).find((f) => f && f.key === declared);
    return field && DEPENDENT_RETENTION_COLUMN_TYPES.includes(field.type) ? field.key : null;
}

/**
 * How a retention purge reaches every table this connector writes.
 *
 * PURE — no database, no clock. That is the point: the connector-save gate and
 * the purge itself must decide from the same rule, and it must not skip a
 * table just because it has no date column of its own. A mailbox in
 * thread mode keeps the conversation stamp on the PARENT and the actual personal
 * data — every body, every sender, every attachment — in children that carry no
 * date at all, so a support desk could report a 90-day policy while deleting
 * nothing that mattered.
 *
 * Two ways a table ages out:
 *   'column'  — it has a date column of its own: a declared `retentionField`, or
 *               the column the sync's incremental stamp maps to
 *   'cascade' — it has none, and inherits its parent's age through the relation
 *               ("when the message goes, its attachments go") — the only honest
 *               semantics for a row whose age is not its own fact
 *
 * Besides `sync.children` (tables the connector WRITES), the plan also walks
 * `sync.dependents`: tables the connector never writes but whose lifetime it
 * governs — an app-written line-items or activity table hanging off the synced
 * conversation. Without them those rows sit in neither `steps` nor
 * `unreachable`, so they outlive the purge as orphans and the save-gate never
 * notices. Same two modes:
 *   { tableId, retentionField }                    — 'column': purged on its own date
 *   { tableId, relationField, parentTableId,
 *     retentionCascade: true }                     — 'cascade': goes when the parent row goes
 * Dependents run AFTER the primary and the children (their parent's purge must
 * have happened for a cascade to see the orphans), in declared order.
 *
 * Anything else lands in `unreachable`, and a connector that promises
 * `retentionDays` with a non-empty `unreachable` must not be saved.
 *
 * @returns {{ days:number, steps:Array<object>, unreachable:string[] }}
 */
function planRetention(model, connector) {
    const sync = isPlainObject(connector?.sync) ? connector.sync : null;
    const days = Number.isInteger(sync?.retentionDays) && sync.retentionDays > 0 ? sync.retentionDays : 0;
    const steps = [];
    const unreachable = [];
    if (!days) return { days: 0, steps, unreachable };

    const byId = new Map((model?.tables || []).filter(isPlainObject).map((t) => [t.id, t]));
    const stamp = isPlainObject(sync.incremental) ? sync.incremental.field : null;

    const primary = byId.get(sync.tableId) || null;
    if (!primary) return { days, steps, unreachable: [String(sync.tableId ?? 'unknown table')] };

    const primaryColumn = datedColumn(primary, sync.retentionField, stamp);
    if (primaryColumn) steps.push({ level: 0, table: primary, mode: 'column', column: primaryColumn });
    else unreachable.push(primary.key);

    const tableByLevel = new Map([[0, primary]]);
    // Tables this plan governs, by id — what a dependent's cascade may name as
    // its parent. A cascade to a table the plan never purges would delete
    // nothing forever, which is exactly the silence `unreachable` exists to end.
    const governedById = new Map([[primary.id, primary]]);
    const children = (Array.isArray(sync.children) ? sync.children : [])
        .filter(isPlainObject)
        .slice()
        .sort((a, b) => (a.level || 0) - (b.level || 0));

    for (const child of children) {
        const table = byId.get(child.tableId);
        if (!table) { unreachable.push(String(child.tableId ?? 'unknown table')); continue; }
        tableByLevel.set(child.level, table);
        governedById.set(table.id, table);

        const column = datedColumn(table, child.retentionField, stamp);
        if (column) { steps.push({ level: child.level, table, mode: 'column', column }); continue; }

        const parent = tableByLevel.get(child.parentLevel ?? 0) || null;
        if (child.retentionCascade && parent && typeof child.relationField === 'string') {
            steps.push({ level: child.level, table, mode: 'cascade', relationField: child.relationField, parentTable: parent });
            continue;
        }
        unreachable.push(table.key);
    }

    // Dependents: tables the connector does NOT write but whose lifetime it
    // governs. They get levels past every child so their steps sort after the
    // rows they hang off — a cascade dependent looks for orphans, and there are
    // none until its parent's own purge has run.
    const dependents = (Array.isArray(sync.dependents) ? sync.dependents : []).filter(isPlainObject);
    let dependentLevel = Math.max(0, ...children.map((c) => c.level || 0)) + 1;
    for (const dep of dependents) {
        const table = byId.get(dep.tableId);
        if (!table) { unreachable.push(String(dep.tableId ?? 'unknown table')); continue; }
        const level = dependentLevel++;

        const column = dependentDatedColumn(table, dep.retentionField);
        if (column) {
            steps.push({ level, table, mode: 'column', column });
            governedById.set(table.id, table);
            continue;
        }

        const parent = dep.parentTableId ? governedById.get(dep.parentTableId) || null : null;
        if (dep.retentionCascade && parent && typeof dep.relationField === 'string') {
            // sweepNull:false — dependents are app-authored, so a row whose
            // relation was left empty is live user data, not an orphan the
            // sync forgot to stamp. Only rows pointing at a purged parent go.
            steps.push({ level, table, mode: 'cascade', relationField: dep.relationField, parentTable: parent, sweepNull: false });
            governedById.set(table.id, table);
            continue;
        }
        unreachable.push(table.key);
    }

    // Parent-first. A cascade step asks "does my parent still exist?", so the
    // parent's own purge has to have run already — otherwise the first pass
    // deletes nothing and the child only catches up a sync later.
    steps.sort((a, b) => a.level - b.level);
    return { days, steps, unreachable };
}

module.exports = { planRetention };
