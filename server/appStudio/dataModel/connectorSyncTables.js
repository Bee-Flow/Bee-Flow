// @typecheck strict
/**
 * App Studio data model — the persisted-shape gate for the two table lists of
 * a connector's sync block: its child tables (the grains the connector writes
 * itself) and its dependent tables (rows it does not write but whose lifetime
 * it governs). Part of validateConnectorSync (connectorValidate.js); every
 * finding is pushed onto `errors` in the order the fields are read.
 */

'use strict';

const { isPlainObject } = require('./shared');
const { DATA_LIMITS, KEY_RE, MAX_CHAIN_STEPS, SOURCE_PATH_RE, DEPENDENT_KEYS, SYNC_MODES } = require('./vocabulary');

/**
 * @typedef {import('./connectorValidate').SyncCfg} SyncCfg
 * @typedef {import('./connectorValidate').SyncChildCfg} SyncChildCfg
 * @typedef {import('./connectorValidate').SyncDependentCfg} SyncDependentCfg
 * @typedef {{ fields?: Array<{ key?: string, type?: string, relation?: { table?: string } }> }} DependentTable
 */

/**
 * A whole number. Number.isInteger, typed as the check it is.
 * @param {unknown} v
 * @returns {v is number}
 */
function isWholeNumber(v) {
    return Number.isInteger(v);
}

/**
 * Child tables — one per chain step that opened a grain of its own, either by
 * EXPANDING ("one row per attachment" is a different grain from "one row per
 * message") or by asking for its own table (ownTable, one child row per parent
 * row). Either way it is joined to the parent by a relation column. `level` is
 * the grain index the runner reports; the rows for it come from that grain,
 * not the flat output.
 * @param {SyncCfg} sync
 * @param {Set<string>} tableIds
 * @param {string} where
 * @param {string[]} errors
 */
function validateSyncChildren(sync, tableIds, where, errors) {
    if (sync.children === undefined) return;
    if (!Array.isArray(sync.children)) {
        errors.push(`${where}.sync.children must be an array of child tables`);
        return;
    }
    if (sync.children.length > MAX_CHAIN_STEPS) {
        errors.push(`${where}.sync.children has more entries (${sync.children.length}) than a chain can have steps (${MAX_CHAIN_STEPS})`);
    }
    /** @type {Set<number>} */
    const seenLevels = new Set();
    for (const [i, child] of sync.children.entries()) {
        const cw = `${where}.sync.children[${i}]`;
        if (!isPlainObject(child)) { errors.push(`${cw} must be an object`); continue; }
        childGrainErrors(child, cw, { syncTableId: sync.tableId, tableIds, seenLevels }, errors);
        childColumnErrors(child, cw, errors);
    }
}

/**
 * Which table a child is and which grain it stores: a table of this app other
 * than the main one, a level used once, and a parent level below it.
 * @param {SyncChildCfg} child
 * @param {string} cw  the child's path, e.g. "connectors[0].sync.children[1]"
 * @param {{ syncTableId: string|undefined, tableIds: Set<string>, seenLevels: Set<number> }} ctx
 * @param {string[]} errors
 */
function childGrainErrors(child, cw, { syncTableId, tableIds, seenLevels }, errors) {
    if (typeof child.tableId !== 'string' || !tableIds.has(child.tableId)) {
        errors.push(`${cw}.tableId must be a table in this app`);
    }
    if (child.tableId === syncTableId) {
        errors.push(`${cw}.tableId must differ from the connector's main table`);
    }
    if (!isWholeNumber(child.level) || child.level < 1) {
        errors.push(`${cw}.level must be the grain this table stores (1 or higher)`);
    } else if (seenLevels.has(child.level)) {
        errors.push(`${cw}.level ${child.level} is used by more than one table`);
    } else { seenLevels.add(child.level); }
    if (child.parentLevel !== undefined
        && (!isWholeNumber(child.parentLevel) || child.parentLevel < 0 || child.parentLevel >= (child.level ?? 0))) {
        errors.push(`${cw}.parentLevel must be a lower grain than ${cw}.level`);
    }
}

/**
 * The columns a child is written and aged out through: the relation to its
 * parent, the key and mode of the write, and how it ages out. A child that
 * carries its own stamp names the column; one that does not — an email
 * attachment has no date of its own — inherits its parent's age through the
 * relation. Declaring neither leaves a child table outside the connector's
 * retention promise entirely.
 * @param {SyncChildCfg} child
 * @param {string} cw
 * @param {string[]} errors
 */
function childColumnErrors(child, cw, errors) {
    if (typeof child.relationField !== 'string' || !KEY_RE.test(child.relationField)) {
        errors.push(`${cw}.relationField must be the column holding the parent's record`);
    }
    if (child.keyField !== undefined && (typeof child.keyField !== 'string' || !SOURCE_PATH_RE.test(child.keyField))) {
        errors.push(`${cw}.keyField must be a field path`);
    }
    if (child.mode !== undefined && !SYNC_MODES.includes(child.mode)) {
        errors.push(`${cw}.mode must be one of ${SYNC_MODES.join(', ')}`);
    }
    if (child.retentionField !== undefined
        && (typeof child.retentionField !== 'string' || !KEY_RE.test(child.retentionField))) {
        errors.push(`${cw}.retentionField must be the column holding this table's timestamp`);
    }
    if (child.retentionCascade !== undefined && typeof child.retentionCascade !== 'boolean') {
        errors.push(`${cw}.retentionCascade must be true or false`);
    }
    if (child.retentionCascade && child.retentionField) {
        errors.push(`${cw} cannot both cascade retention from its parent and carry its own retentionField`);
    }
}

/**
 * Dependent tables — rows the connector does NOT write but whose lifetime it
 * governs: an app-written line-items or activity table hanging off the synced
 * conversation. Declaring one is what pulls it into planRetention; without it
 * those rows land in neither steps nor unreachable and outlive the purge as
 * orphans no gate ever sees. Two modes, mirroring children: a date column of
 * its own, or a cascade through a relation to a table the connector purges.
 * Validated against the REAL columns (type included) because, unlike a child,
 * the connector never writes these tables — there is no sync stamp to fall
 * back to and no control over what a text column holds.
 * @param {SyncCfg} sync
 * @param {Set<string>} tableIds
 * @param {Map<string, DependentTable>|null} tablesById  the tables' field metadata, when the caller has it
 * @param {string} where
 * @param {string[]} errors
 */
function validateSyncDependents(sync, tableIds, tablesById, where, errors) {
    if (sync.dependents === undefined) return;
    if (!Array.isArray(sync.dependents)) {
        errors.push(`${where}.sync.dependents must be an array of dependent tables`);
        return;
    }
    if (sync.dependents.length > DATA_LIMITS.MAX_TABLES_PER_APP) {
        errors.push(`${where}.sync.dependents has more entries (${sync.dependents.length}) than this app can have tables (${DATA_LIMITS.MAX_TABLES_PER_APP})`);
    }
    for (const [i, dep] of sync.dependents.entries()) {
        const dw = `${where}.sync.dependents[${i}]`;
        if (!isPlainObject(dep)) { errors.push(`${dw} must be an object`); continue; }
        for (const dk of Object.keys(dep)) {
            if (!DEPENDENT_KEYS.includes(dk)) {
                errors.push(`${dw}.${dk} is not allowed — a dependent may only carry { tableId, retentionField } or { tableId, relationField, parentTableId, retentionCascade }`);
            }
        }
        const depTable = (typeof dep.tableId === 'string' && tablesById) ? tablesById.get(dep.tableId) : null;
        if (typeof dep.tableId !== 'string' || !tableIds.has(dep.tableId)) {
            errors.push(`${dw}.tableId must be a table in this app`);
        }
        if (dep.tableId === sync.tableId) {
            errors.push(`${dw}.tableId must differ from the connector's main table`);
        }
        dependentRetentionErrors(dep, depTable, dw, errors);
        if (dep.retentionCascade) dependentCascadeErrors(dep, depTable, tableIds, dw, errors);
    }
}

/**
 * A dependent's own date column (a date or datetime column on that table),
 * and the rule that it cannot also cascade.
 * @param {SyncDependentCfg} dep
 * @param {DependentTable|null|undefined} depTable
 * @param {string} dw  the dependent's path
 * @param {string[]} errors
 */
function dependentRetentionErrors(dep, depTable, dw, errors) {
    if (dep.retentionField !== undefined) {
        if (typeof dep.retentionField !== 'string' || !KEY_RE.test(dep.retentionField)) {
            errors.push(`${dw}.retentionField must be the column holding this table's timestamp`);
        } else if (depTable) {
            const f = (Array.isArray(depTable.fields) ? depTable.fields : [])
                .find((x) => isPlainObject(x) && x.key === dep.retentionField);
            if (!f) {
                errors.push(`${dw}.retentionField "${dep.retentionField}" is not a column on that table`);
            } else if (f.type !== 'datetime' && f.type !== 'date') {
                errors.push(`${dw}.retentionField "${dep.retentionField}" must be a date or datetime column, not ${f.type}`);
            }
        }
    }
    if (dep.retentionCascade !== undefined && typeof dep.retentionCascade !== 'boolean') {
        errors.push(`${dw}.retentionCascade must be true or false`);
    }
    if (dep.retentionCascade && dep.retentionField) {
        errors.push(`${dw} cannot both cascade retention from its parent and carry its own retentionField`);
    }
}

/**
 * A cascading dependent's parent table and the relation column that points
 * at it.
 * @param {SyncDependentCfg} dep
 * @param {DependentTable|null|undefined} depTable
 * @param {Set<string>} tableIds
 * @param {string} dw
 * @param {string[]} errors
 */
function dependentCascadeErrors(dep, depTable, tableIds, dw, errors) {
    if (typeof dep.parentTableId !== 'string' || !tableIds.has(dep.parentTableId)) {
        errors.push(`${dw}.parentTableId must be a table in this app`);
    }
    if (typeof dep.relationField !== 'string' || !KEY_RE.test(dep.relationField)) {
        errors.push(`${dw}.relationField must be the column holding the parent's record`);
    } else if (depTable) {
        const rel = (Array.isArray(depTable.fields) ? depTable.fields : [])
            .find((x) => isPlainObject(x) && x.key === dep.relationField);
        if (!rel || rel.type !== 'relation') {
            errors.push(`${dw}.relationField "${dep.relationField}" must be a relation column on that table`);
        } else if (typeof dep.parentTableId === 'string' && rel.relation?.table !== dep.parentTableId) {
            errors.push(`${dw}.relationField "${dep.relationField}" does not point at parentTableId "${dep.parentTableId}"`);
        }
    }
}

module.exports = { validateSyncChildren, validateSyncDependents };
