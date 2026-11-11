// @typecheck strict
/**
 * App Studio data model — migration planning for what is not a column: the junction table of
 * a many relation and the declared indexes of a table (linkedFields.js). Every step takes the
 * plan context migrationPlan builds and pushes onto `p.plan`; a model without either plans
 * exactly as before (no statement, no op).
 *
 *   junctionSteps   after the new columns (4): CREATE TABLE IF NOT EXISTS for every many
 *                   relation that is new, or that was a single relation (its links are copied
 *                   from the column, which stays where it is); a many relation that becomes
 *                   single again gets its column back, filled with one of its links (the
 *                   junction stays, so nothing is lost).
 *   indexSteps      after the unique toggles (5), before the dropped columns (6): DROP INDEX
 *                   for every declared index that is gone, CREATE INDEX IF NOT EXISTS for every
 *                   new one. An index is named from the stable ids of its table and fields, so a
 *                   rename changes nothing, and adding one is that single statement: no table
 *                   is rebuilt and no row changes.
 *   dropJunctions   before the dropped tables (7), never under retainRetired: the junction of a
 *                   dropped many relation, or of any many relation of a dropped table.
 */

'use strict';

const { qi, addColumnDdl, isAlterPhysical, isStoredComputed } = require('./ddl');
const { isManyRelation, junctionName, tableIndexName, JUNCTION_SOURCE, JUNCTION_TARGET } = require('./linkedFields');
const { SYSTEM_COLUMNS } = require('./vocabulary');
const { isPhysical } = require('./migrationShape');

/** @typedef {import('./migrationShape').ModelTable} ModelTable */
/** @typedef {import('./migrationShape').ModelField} ModelField */
/**
 * The part of migrationPlan's context these steps read.
 * @typedef {{ oldTables: Map<string, ModelTable>, newTables: Map<string, ModelTable>, newKeyById: Map<string, string>,
 *   retain: unknown, inScope: (id: string) => boolean, alterable: (id: string) => boolean, physical: Set<string>,
 *   materialised: Set<string>, dialect: string | undefined, plan: string[] }} LinkedPlanContext
 */

/**
 * The key of the table a relation names (by id or by key) in the new model, or null.
 * @param {LinkedPlanContext} p
 * @param {ModelField} field
 */
function targetKeyOf(p, field) {
    const ref = field.relation && field.relation.table;
    if (typeof ref !== 'string') return null;
    if (p.newKeyById.has(ref)) return /** @type {string} */ (p.newKeyById.get(ref));
    return [...p.newKeyById.values()].includes(ref) ? ref : null;
}

/**
 * CREATE TABLE for the junction of one many relation, and the index its reverse lookups use.
 * Both links cascade with the row they name, so a delete on any path leaves no link behind.
 * @param {{ id: string, key: string }} table
 * @param {{ id: string }} field
 * @param {string | null} targetKey
 */
function junctionDdl(table, field, targetKey) {
    const jn = junctionName(table.id, field.id);
    const ref = (/** @type {string | null} */ key) => (key ? ` REFERENCES ${qi(key)}(id) ON DELETE CASCADE` : '');
    return [
        `CREATE TABLE IF NOT EXISTS ${qi(jn)} (\n  ${qi(JUNCTION_SOURCE)} TEXT NOT NULL${ref(table.key)},\n`
            + `  ${qi(JUNCTION_TARGET)} TEXT NOT NULL${ref(targetKey)},\n  PRIMARY KEY (${qi(JUNCTION_SOURCE)}, ${qi(JUNCTION_TARGET)})\n)`,
        `CREATE INDEX IF NOT EXISTS ${qi(`${jn}_t`)} ON ${qi(jn)} (${qi(JUNCTION_TARGET)})`,
    ];
}

/**
 * The tables a junction step looks at: in scope, with storage of their own, with the table as
 * it was (null for a table this plan creates).
 * @param {LinkedPlanContext} p
 * @returns {Generator<[ModelTable, ModelTable | null]>}
 */
function* physicalTables(p) {
    for (const [id, nt] of p.newTables) {
        if (!p.inScope(id) || !p.physical.has(id)) continue;
        const ot = p.oldTables.get(id);
        yield [nt, ot && !p.materialised.has(id) ? ot : null];
    }
}

/**
 * A many relation that was a single relation: copy its column into the junction (only links to
 * rows that exist, so the junction's foreign key holds).
 * @param {ModelTable} nt
 * @param {ModelField} of
 * @param {string | null} targetKey
 * @param {string} jn
 */
function copyColumnLinks(nt, of, targetKey, jn) {
    const col = qi(of.key);
    const exists = targetKey ? ` AND ${col} IN (SELECT ${qi('id')} FROM ${qi(targetKey)})` : '';
    return `INSERT INTO ${qi(jn)} (${qi(JUNCTION_SOURCE)}, ${qi(JUNCTION_TARGET)}) SELECT ${qi('id')}, ${col} FROM ${qi(nt.key)} `
        + `WHERE ${col} IS NOT NULL${exists} ON CONFLICT DO NOTHING`;
}

/**
 * The plan for one field of a surviving or new table.
 * @param {LinkedPlanContext} p
 * @param {ModelTable} nt
 * @param {ModelField} nf
 * @param {ModelField | undefined} of
 */
function junctionStepsFor(p, nt, nf, of) {
    const targetKey = targetKeyOf(p, nf);
    if (isManyRelation(nf) && !(of && isManyRelation(of))) {
        const jn = junctionName(nt.id, nf.id);
        p.plan.push(...junctionDdl(nt, nf, targetKey));
        if (of && of.type === 'relation') p.plan.push(copyColumnLinks(nt, of, targetKey, jn));
        return;
    }
    if (of && isManyRelation(of) && nf.type === 'relation' && !isManyRelation(nf)) {
        const jn = junctionName(nt.id, nf.id);
        p.plan.push(...addColumnDdl(nt.key, nt.id, nf, p.newKeyById, p.dialect));
        p.plan.push(`UPDATE ${qi(nt.key)} SET ${qi(nf.key)} = (SELECT MIN(${qi(JUNCTION_TARGET)}) FROM ${qi(jn)} `
            + `WHERE ${qi(JUNCTION_SOURCE)} = ${qi(nt.key)}.${qi('id')}) WHERE ${qi(nf.key)} IS NULL`);
    }
}

/**
 * Junction tables for new many relations, and the two directions a relation can switch.
 * @param {LinkedPlanContext} p
 */
function junctionSteps(p) {
    for (const [nt, ot] of physicalTables(p)) {
        const oldById = new Map((ot ? ot.fields : []).map((f) => [f.id, f]));
        for (const nf of nt.fields) junctionStepsFor(p, nt, nf, oldById.get(nf.id));
    }
}

/**
 * Drop the junction of every many relation that leaves the model with its field or its table.
 * @param {LinkedPlanContext} p
 */
function dropJunctions(p) {
    if (p.retain) return;
    for (const [id, ot] of p.oldTables) {
        if (!p.inScope(id) || !isPhysical(ot)) continue;
        // A field that stays (a many relation turned single included) keeps its links.
        const kept = new Set((p.newTables.get(id)?.fields || []).map((f) => f.id));
        for (const of of ot.fields) {
            if (isManyRelation(of) && !kept.has(of.id)) p.plan.push(`DROP TABLE IF EXISTS ${qi(junctionName(ot.id, of.id))}`);
        }
    }
}

/**
 * A column a declared index may name: a system column or a field with a stored column.
 * @param {ModelTable} table
 * @param {unknown} ref  a field key or id
 * @returns {{ id: string, key: string } | null}
 */
function indexColumn(table, ref) {
    if (typeof ref !== 'string' || !ref) return null;
    if (SYSTEM_COLUMNS.includes(ref)) return { id: ref, key: ref };
    const field = table.fields.find((f) => f.key === ref || f.id === ref);
    if (!field || !(isAlterPhysical(field) || isStoredComputed(field))) return null;
    return { id: field.id, key: field.key };
}

/**
 * The declared indexes of a table as name → CREATE INDEX statement. An entry that names a
 * column the table does not have is left out (the validator reports it).
 * @param {ModelTable | null} table
 * @returns {Map<string, string>}
 */
function declaredIndexes(table) {
    /** @type {Map<string, string>} */
    const out = new Map();
    const list = table && Array.isArray(table.indexes) ? table.indexes : [];
    for (const entry of list) {
        const refs = entry && typeof entry === 'object' && Array.isArray(entry.fields) ? entry.fields : [];
        const cols = refs.map((r) => indexColumn(/** @type {ModelTable} */ (table), r));
        if (!cols.length || cols.some((c) => !c)) continue;
        const ok = /** @type {Array<{ id: string, key: string }>} */ (cols);
        const name = tableIndexName(/** @type {ModelTable} */ (table).id, ok.map((c) => c.id));
        out.set(name, `CREATE INDEX IF NOT EXISTS ${qi(name)} ON ${qi(/** @type {ModelTable} */ (table).key)} (${ok.map((c) => qi(c.key)).join(', ')})`);
    }
    return out;
}

/**
 * Drop the declared indexes that are gone, create the new ones.
 * @param {LinkedPlanContext} p
 */
function indexSteps(p) {
    for (const [nt, ot] of physicalTables(p)) {
        const before = declaredIndexes(ot);
        const after = declaredIndexes(nt);
        for (const name of before.keys()) if (!after.has(name)) p.plan.push(`DROP INDEX IF EXISTS ${qi(name)}`);
        for (const [name, sql] of after) if (!before.has(name)) p.plan.push(sql);
    }
}

module.exports = { junctionSteps, dropJunctions, indexSteps, junctionDdl, declaredIndexes };
