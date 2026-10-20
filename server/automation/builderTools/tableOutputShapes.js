// @typecheck
/**
 * What the two table steps output, as shapes for the builder's reference
 * check (refCheck.js): `steps.<id>.output.<key>` is checked against these, so a
 * misspelt key is refused with a "did you mean" instead of reaching run time.
 *
 * The handle is open (a key a later phase adds is never refused); the lists
 * and records of an output are as the executors write them
 * (core/automationRunner/execReadTable.js, execTable.js).
 */

'use strict';

const str = () => ({ t: 'str' });
const num = () => ({ t: 'num' });
const bool = () => ({ t: 'bool' });
const arr = (item) => ({ t: 'arr', item, sure: true });
const obj = (entries, { open = false } = {}) => ({ t: 'obj', keys: new Map(entries), open, sure: true });

const openRecord = () => obj([], { open: true });
const column = () => obj([['key', str()], ['label', str()], ['type', str()]]);

/** A table handle (core/automationRunner/tables/handle.js): open, so a key a later phase adds is never refused. */
function tableHandleShape() {
    return obj([
        ['kind', str()], ['tableId', str()], ['runId', str()], ['name', str()],
        ['columns', arr(column())],
        ['rowCount', num()], ['preview', arr(openRecord())],
        ['previewCut', bool()], ['expiresAt', str()], ['provenance', openRecord()],
    ], { open: true });
}

/** read_table (execReadTable.js): one handle per sheet, by position and by sheet name. */
function readTableOutputShape() {
    const sheet = obj([
        ['name', str()], ['index', num()], ['hidden', bool()], ['rowCount', num()], ['columnCount', num()],
        ['tableIndex', num()], ['skipped', str()],
    ]);
    return obj([
        ['tables', arr(tableHandleShape())],
        ['table', tableHandleShape()],
        ['tablesByName', openRecord()],
        ['sheets', arr(sheet)],
        ['provenance', openRecord()],
        ['source', obj([['filename', str()], ['format', str()], ['size', num()]])],
        ['warnings', arr(str())],
    ]);
}

/** table (execTable.js): the handle, and the rows themselves only when the result is small. */
function tableOutputShape() {
    const segment = obj([
        ['id', str()], ['label', str()], ['column', str()], ['value', str()], ['n', num()],
        ['rules', arr(openRecord())],
    ]);
    return obj([
        ['table', tableHandleShape()], ['rowCount', num()],
        ['columns', arr(column())],
        ['rows', arr(openRecord())],
        ['markdown', str()], ['rowsOmitted', bool()],
        ['segments', arr(segment)],
        ['description', openRecord()],
        ['opStats', arr(openRecord())],
        ['warnings', arr(str())],
    ]);
}

/**
 * The output shape of a table step, or null for any other step type.
 * @param {{ type?: string }} step
 */
function tableStepOutputShape(step) {
    if (step && step.type === 'read_table') return readTableOutputShape();
    if (step && step.type === 'table') return tableOutputShape();
    return null;
}

module.exports = { tableStepOutputShape, readTableOutputShape, tableOutputShape, tableHandleShape };
