/**
 * "Edit data" (set) whole-table operations: the operation vocabulary, its
 * count ceiling, and the per-operation shape rules.
 */

const { isObject } = require('./helpers');
const { RESERVED_PROTO_KEYS } = require('./constants');

// "Edit data" (set) whole-table operations. Mirrors engine.js: rowId/groupId
// add a column, rename/keep/remove reshape columns, sort orders rows.
const SET_OPS = new Set(['rowId', 'groupId', 'rename', 'keep', 'remove', 'sort']);
const MAX_SET_OPERATIONS = 20;

// Column names for set operations are TOP-LEVEL keys (the same contract every
// collection op has — the executor reads `row[k]`). Reserved proto names are
// integrity errors: the op is new, so no legacy draft can carry one.
function validSetColumn(k) {
    return typeof k === 'string' && k.trim().length > 0;
}

function validateSetOperation(step, o, oi, oat, pushE, pushW) {
    if (!isObject(o)) {
        pushE({ code: 'set.op_shape', severity: 'error', path: oat, message: `Step ${step.id}: operation ${oi} must be an object with an \`op\` field.`, hint: 'e.g. { op: "rowId", target: "id" }.' });
        return;
    }
    if (!SET_OPS.has(o.op)) {
        pushE({ code: 'set.op_unknown', severity: 'error', path: `${oat}.op`, message: `Step ${step.id}: unknown operation "${o.op}".`, hint: `Use one of: ${Array.from(SET_OPS).join(', ')}.` });
        return;
    }
    const checkTarget = (name, key) => {
        if (!validSetColumn(name)) {
            pushE({ code: 'set.op_target_missing', severity: 'error', path: `${oat}.${key}`, message: `Step ${step.id}: operation "${o.op}" needs a column name in \`${key}\`.`, hint: 'Pick the column the operation writes to.' });
            return false;
        }
        if (RESERVED_PROTO_KEYS.has(name)) {
            pushE({ code: 'set.op_target_reserved', severity: 'error', path: `${oat}.${key}`, message: `Step ${step.id}: column name "${name}" is reserved — it would silently vanish at run time.`, hint: 'Rename it; __proto__/constructor/prototype cannot be object keys here.' });
            return false;
        }
        return true;
    };
    if (o.op === 'rowId') {
        checkTarget(o.target, 'target');
        if (o.start !== undefined && !Number.isInteger(o.start)) {
            pushE({ code: 'set.op_rowid_start_invalid', severity: 'error', path: `${oat}.start`, message: `Step ${step.id}: rowId \`start\` must be a whole number.`, hint: 'Omit it to start at 1.' });
        }
    }
    if (o.op === 'groupId') {
        checkTarget(o.target, 'target');
        const keys = Array.isArray(o.keys) ? o.keys.filter(validSetColumn) : [];
        if (keys.length === 0) {
            pushE({ code: 'set.op_keys_missing', severity: 'error', path: `${oat}.keys`, message: `Step ${step.id}: groupId needs at least one column in \`keys\`.`, hint: 'Rows whose values in these columns match get the same id.' });
        }
    }
    if (o.op === 'rename') {
        if (!validSetColumn(o.from) || !validSetColumn(o.to)) {
            pushE({ code: 'set.op_rename_incomplete', severity: 'error', path: oat, message: `Step ${step.id}: rename needs both \`from\` and \`to\` column names.`, hint: 'Pick the column to rename and its new name.' });
        } else if (RESERVED_PROTO_KEYS.has(o.to)) {
            pushE({ code: 'set.op_target_reserved', severity: 'error', path: `${oat}.to`, message: `Step ${step.id}: column name "${o.to}" is reserved — it would silently vanish at run time.`, hint: 'Rename it; __proto__/constructor/prototype cannot be object keys here.' });
        } else if (o.from === o.to) {
            pushW({ code: 'set.op_rename_noop', severity: 'warning', path: oat, message: `Step ${step.id}: renaming "${o.from}" to itself does nothing.`, hint: 'Change the new name, or remove this operation.' });
        }
    }
    if (o.op === 'keep' || o.op === 'remove') {
        const keys = Array.isArray(o.keys) ? o.keys.filter(validSetColumn) : [];
        if (keys.length === 0) {
            pushE({ code: 'set.op_keys_missing', severity: 'error', path: `${oat}.keys`, message: `Step ${step.id}: ${o.op} needs at least one column in \`keys\`.`, hint: o.op === 'keep' ? 'List the columns to keep; everything else is dropped.' : 'List the columns to remove.' });
        }
    }
    if (o.op === 'sort') {
        if (!validSetColumn(o.key)) {
            pushE({ code: 'set.op_sort_key_missing', severity: 'error', path: `${oat}.key`, message: `Step ${step.id}: sort needs a column in \`key\`.`, hint: 'Pick the column to sort the rows by.' });
        }
        if (o.direction !== undefined && o.direction !== 'asc' && o.direction !== 'desc') {
            pushE({ code: 'set.op_sort_direction_invalid', severity: 'error', path: `${oat}.direction`, message: `Step ${step.id}: sort \`direction\` must be "asc" or "desc".`, hint: 'Omit it for ascending.' });
        }
    }
}

module.exports = { SET_OPS, MAX_SET_OPERATIONS, validSetColumn, validateSetOperation };
