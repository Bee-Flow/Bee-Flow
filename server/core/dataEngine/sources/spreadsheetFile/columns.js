// @typecheck strict
/**
 * Header cells → datatable fields, deterministically — the spreadsheet twin
 * of ../nextcloudTable/columns.js, with one difference that shapes everything:
 * a sheet column has NO id. Nextcloud numbers its columns; a worksheet has a
 * header row and a position, and the position moves every time someone
 * inserts a column on the left.
 *
 * ── STRICT COLUMN IDENTITY ──────────────────────────────────────────
 * The header text IS the identity. A field id is derived from it —
 * `fld_ss<sha256('ss\0' + slug(header))[0:10]><type code>` — never minted, so
 * it survives every refresh and every re-link, and the migration planner
 * (which diffs models BY ID) sees exactly what happened:
 *   • a column moved left or right   → same id, `col` updated, data kept;
 *   • a header renamed               → the old id is gone, a new one is
 *                                      added and refilled by the same pass
 *                                      (the file is the truth; no position
 *                                      guessing that could pair the wrong
 *                                      columns and silently swap their data);
 *   • a column retyped by the owner  → same header hash, other type code —
 *                                      DROP + ADD under the SAME KEY, exactly
 *                                      as a Nextcloud retype (schema.js).
 * Two equal headers hash `slug + '#' + col` for the second; an empty header
 * hashes `'#col' + col` and is shown as its column letter.
 *
 * ── TYPES ARE DECLARED ──────────────────────────────────────────────
 * The wizard infers a type once (infer.js) and the linker confirms it; from
 * then on it is DECLARED in `columnMap[id].type` and never re-inferred from
 * data — a column of invoice numbers does not become a number column the day
 * every open invoice happens to be numeric. A cell that does not fit lands
 * NULL and is counted (rows.js). Only `select` is an opt-in: its options are
 * the values the wizard saw, grown on sync, never shrunk.
 *
 * The KEY is derived once, from the header, and then KEPT (automations and apps
 * name a column by key). A formula column is `derived: true` — read-only,
 * its value is the file's cached result. Declared `match` relations are the
 * same shape as Nextcloud's, under the `fld_ssrel` prefix.
 *
 * PURE: no database, no network. link.js and sync.js feed it and act on
 * `changes` / `retyped`. The header → name / hash / id primitives are in
 * columnIdentity.js and re-exported here.
 */

'use strict';

const { DATA_LIMITS } = require('../../dataModel/vocabulary');
const { keyFromTitle, TYPE_CODE } = require('../mirror/keys');
const { formatOfNumFmt } = require('./cells');
const {
    ID_PREFIX, MATCH_PREFIX, columnLetter, headerText, slugOf, describeHeader,
    fieldIdFor, parseFieldId, matchFieldIdFor, keyTitleFor,
} = require('./columnIdentity');

/** What infer.js may conclude from cells. */
const INFERABLE_TYPES = Object.freeze(['text', 'number', 'date', 'datetime', 'bool']);
/** What the wizard / `PUT /:id/source` may declare (select is the one opt-in). */
const DECLARABLE_TYPES = Object.freeze([...INFERABLE_TYPES, 'select']);

/** @typedef {{ col: number, header?: unknown, type?: string, formula?: boolean, options?: unknown, numFmt?: unknown, format?: string, dateFormat?: unknown }} SheetColumn */
/** @typedef {{ col?: number, header?: string, headerHash?: string, type?: string, options?: string[], format?: string, numFmt?: string, dateFormat?: string, formula?: boolean, key?: boolean, derived?: string, localFieldId?: string, targetFieldId?: string }} ColumnMapEntry */
/** @typedef {{ id: string, key: string, name: string, type: string, options?: string[], derived?: boolean, required?: boolean, relation?: { table: string, fk: boolean } }} MirrorField */
/** @typedef {{ id?: string, key?: string, name?: string, options?: unknown }} ExistingField */
/** @typedef {{ targetDatatableId: string, targetKey?: string, targetName?: string, localFieldId: string, targetFieldId: string }} DeclaredRelation */

/** @typedef {{ id: string, entry: ColumnMapEntry | null, field: ExistingField | null }} PriorColumn */
/** @typedef {{ c: SheetColumn, d: ReturnType<typeof describeHeader>[number], type: string, id: string }} PlannedColumn */
/** @typedef {{ fields: MirrorField[], columnMap: Record<string, ColumnMapEntry>, relations: Array<{ fieldId: string, kind: string, targetDatatableId: string, localFieldId: string, targetFieldId: string }>, warnings: string[], changes: string[] }} SheetFieldsOut */

/**
 * The mirror's prior fields by id, its column map, and every header hash under
 * its PREVIOUS type code: a retype drops the old field and adds a new one, but
 * the key (what automations name) carries over, because to a person it is
 * still the same column.
 * @param {ExistingField[]} existingFields
 * @param {Record<string, ColumnMapEntry>} existingColumnMap
 */
function priorMirror(existingFields, existingColumnMap) {
    const prior = new Map((Array.isArray(existingFields) ? existingFields : [])
        .filter(f => f && typeof f.id === 'string').map(f => [/** @type {string} */ (f.id), f]));
    const priorEntries = existingColumnMap && typeof existingColumnMap === 'object' ? existingColumnMap : {};
    /** @type {Map<string, PriorColumn>} */
    const priorByHash = new Map();
    for (const [id, entry] of Object.entries(priorEntries)) {
        if (!entry || entry.derived) continue;
        const hash = entry.headerHash || parseFieldId(id)?.headerHash;
        if (hash) priorByHash.set(hash, { id, entry, field: prior.get(id) || null });
    }
    for (const f of prior.values()) {
        const parsed = parseFieldId(f.id);
        if (parsed && !priorByHash.has(parsed.headerHash)) priorByHash.set(parsed.headerHash, { id: /** @type {string} */ (f.id), entry: null, field: f });
    }
    return { prior, priorEntries, priorByHash };
}

/**
 * Overrides arrive keyed by the field id the caller knows (the OLD id of a
 * retyped column) or by header hash; both resolve to a hash.
 * @param {Record<string, { type?: string } | string>} overrides
 * @param {Record<string, ColumnMapEntry>} priorEntries
 */
function overrideTypes(overrides, priorEntries) {
    /** @type {Map<string, string>} */
    const typeByHash = new Map();
    for (const [k, v] of Object.entries(overrides || {})) {
        const type = v && typeof v === 'object' ? v.type : /** @type {string} */ (v);
        if (typeof type !== 'string' || !DECLARABLE_TYPES.includes(type)) continue;
        const hash = priorEntries[k]?.headerHash || parseFieldId(k)?.headerHash || (/^[0-9a-f]{10}$/.test(k) ? k : null);
        if (hash) typeByHash.set(hash, type);
    }
    return typeByHash;
}

/**
 * A column's type: an override, else its declared type, else the prior
 * declaration, else text. A type it cannot be, or a list without options, is
 * text with a warning.
 * @param {SheetColumn} c
 * @param {PlannedColumn['d']} d
 * @param {Map<string, string>} typeByHash
 * @param {Map<string, PriorColumn>} priorByHash
 * @param {string[]} warnings
 */
function declaredType(c, d, typeByHash, priorByHash, warnings) {
    let type = typeByHash.get(d.headerHash)
        || (typeof c.type === 'string' && DECLARABLE_TYPES.includes(c.type) ? c.type : null)
        || priorByHash.get(d.headerHash)?.entry?.type
        || null;
    if (c.type && !DECLARABLE_TYPES.includes(c.type) && !typeByHash.has(d.headerHash)) {
        warnings.push(`"${d.name}" cannot be a ${c.type} column here; it arrives as text.`);
        type = 'text';
    }
    if (type === 'select' && !optionList(c.options).length) {
        warnings.push(`"${d.name}" is a list column without options, so its values arrive as text.`);
        type = 'text';
    }
    return type || 'text';
}

/** @param {DeclaredRelation | null | undefined} rel */
const isDeclaredRelation = rel => Boolean(rel && rel.targetDatatableId && rel.localFieldId && rel.targetFieldId);

/**
 * The keys of columns and relation fields that STAY, reserved before any key
 * is minted (a new column titled like an old one must not steal its key).
 * @param {PlannedColumn[]} plan
 * @param {DeclaredRelation[]} declaredRelations
 * @param {Map<string, ExistingField>} prior
 * @param {Set<string>} reservedKeys
 */
function keysInUse(plan, declaredRelations, prior, reservedKeys) {
    const used = new Set(reservedKeys);
    const ids = plan.map(p => p.id);
    for (const rel of declaredRelations) {
        if (isDeclaredRelation(rel)) ids.push(matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId));
    }
    for (const id of ids) {
        const k = prior.get(id);
        if (k && k.key) used.add(k.key);
    }
    return used;
}

/**
 * A column's key: the kept one, else the key of the same header under its old
 * type when still free, else one minted from the header.
 * @param {PlannedColumn} p
 * @param {ExistingField | undefined} keptField
 * @param {Map<string, PriorColumn>} priorByHash
 * @param {Set<string>} used
 */
function columnKey(p, keptField, priorByHash, used) {
    if (keptField && keptField.key) return keptField.key;
    const priorSame = priorByHash.get(p.d.headerHash);
    const retypedFrom = !keptField && priorSame && priorSame.field && priorSame.id !== p.id ? priorSame.field : null;
    if (retypedFrom && retypedFrom.key && !used.has(retypedFrom.key)) return retypedFrom.key;
    return keyFromTitle(keyTitleFor(p.d), p.c.col + 1, used);
}

/**
 * One column's mirror field and column-map entry.
 * @param {PlannedColumn} p
 * @param {string} key
 * @param {number | null} keyCol
 */
function columnFieldAndEntry({ c, d, type, id }, key, keyCol) {
    /** @type {MirrorField} */
    const field = { id, key, name: d.name || key, type };
    /** @type {ColumnMapEntry} */
    const entry = { col: c.col, header: d.header, headerHash: d.headerHash, type };
    if (type === 'select') {
        const options = optionList(c.options);
        field.options = options;
        entry.options = options;
    }
    const format = c.format || ((type === 'date' || type === 'datetime') ? 'date' : formatOfNumFmt(c.numFmt));
    if (format) entry.format = format;
    if (c.numFmt) entry.numFmt = String(c.numFmt);
    if (c.dateFormat) entry.dateFormat = String(c.dateFormat);
    if (c.formula) { field.derived = true; entry.formula = true; }
    const isKey = Number.isInteger(keyCol) && keyCol === c.col;
    if (isKey) { field.required = true; entry.key = true; }
    return { field, entry, isKey };
}

/**
 * A column's change lines: added, or renamed and/or moved.
 * @param {ExistingField | undefined} keptField
 * @param {ColumnMapEntry | undefined} priorEntry
 * @param {MirrorField} field
 * @param {number} col
 */
function columnChanges(keptField, priorEntry, field, col) {
    if (!keptField) return [`added:${field.key}`];
    const changes = [];
    if (keptField.name !== field.name) changes.push(`renamed:${field.key}`);
    if (priorEntry && Number.isInteger(priorEntry.col) && priorEntry.col !== col) changes.push(`moved:${field.key}`);
    return changes;
}

/**
 * Declared relations, after the sheet's columns so their keys never shadow one.
 * @param {DeclaredRelation[]} declaredRelations
 * @param {Map<string, ExistingField>} prior
 * @param {Set<string>} used
 * @param {Set<string>} seenIds
 * @param {SheetFieldsOut} out
 */
function addRelationFields(declaredRelations, prior, used, seenIds, out) {
    for (const rel of declaredRelations) {
        if (!isDeclaredRelation(rel)) continue;
        if (!seenIds.has(rel.localFieldId) && !prior.has(rel.localFieldId)) {
            out.warnings.push(`A declared relation names a column this table no longer has (${rel.localFieldId}); it is skipped.`);
            continue;
        }
        const id = matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId);
        const keptField = prior.get(id);
        const key = keptField && keptField.key ? keptField.key : keyFromTitle(`${rel.targetKey || 'related'}_ref`, 0, used);
        used.add(key);
        seenIds.add(id);
        out.fields.push({
            id, key,
            name: keptField && keptField.name ? keptField.name : `${rel.targetName || rel.targetKey || 'Related'} row`,
            type: 'relation', derived: true,
            relation: { table: rel.targetDatatableId, fk: false },
        });
        out.columnMap[id] = { derived: 'match', localFieldId: rel.localFieldId, targetFieldId: rel.targetFieldId };
        out.relations.push({ fieldId: id, kind: 'match', targetDatatableId: rel.targetDatatableId, localFieldId: rel.localFieldId, targetFieldId: rel.targetFieldId });
        if (!keptField) out.changes.push(`added:${key}`);
    }
}

/**
 * What the previous shape had and this one does not: a header that is gone
 * (or renamed: same thing, to us), or a column retyped (same header hash, new
 * type code, new field id). Returns the retyped fields.
 * @param {Map<string, ExistingField>} prior
 * @param {Set<string>} seenIds
 * @param {Set<string>} hashesNow
 * @param {string[]} changes
 */
function droppedFields(prior, seenIds, hashesNow, changes) {
    const retyped = [];
    for (const old of prior.values()) {
        if (seenIds.has(/** @type {string} */ (old.id))) continue;
        const parsed = parseFieldId(old.id);
        if (parsed && hashesNow.has(parsed.headerHash)) { retyped.push(old); changes.push(`retyped:${old.key}`); }
        else changes.push(`removed:${old.key}`);
    }
    return retyped;
}

/**
 * @param {SheetColumn[]} columns   [{ col, header, type?, formula?, options?, numFmt?, format?, dateFormat? }] in sheet order
 * @param {{ existingFields?: ExistingField[], existingColumnMap?: Record<string, ColumnMapEntry>,
 *   declaredRelations?: DeclaredRelation[], keyCol?: number|null,
 *   overrides?: Record<string, { type?: string } | string>, reservedKeys?: Set<string> }} [ctx]
 *   `existingFields`: the mirror's current fields (identity + kept keys); `existingColumnMap`: the
 *   mirror's current source.columnMap (prior cols, types, hashes); `declaredRelations`: [{
 *   targetDatatableId, targetKey, targetName, localFieldId, targetFieldId }]; `keyCol`: 0-based column
 *   of the key column (required:true); `overrides`: { [fieldId|headerHash]: { type } } — retypes from
 *   the wizard / PUT /:id/source; `reservedKeys`: keys this mirror must not use
 * @returns {SheetFieldsOut & { retyped:ExistingField[], keyFieldId:string|null }}
 */
function fieldsFromSheet(columns, {
    existingFields = [], existingColumnMap = {}, declaredRelations = [],
    keyCol = null, overrides = {}, reservedKeys = new Set(),
} = {}) {
    const { prior, priorEntries, priorByHash } = priorMirror(existingFields, existingColumnMap);
    /** @type {SheetFieldsOut} */
    const out = { fields: [], columnMap: {}, relations: [], warnings: [], changes: [] };
    const cols = (Array.isArray(columns) ? columns : []).filter(c => c && Number.isInteger(c.col) && c.col >= 0);
    if (cols.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
        out.warnings.push(`Only the first ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} of ${cols.length} columns are mirrored.`);
    }
    const kept = cols.slice(0, DATA_LIMITS.MAX_FIELDS_PER_TABLE);
    const described = describeHeader(kept.map(c => ({ col: c.col, header: c.header })));
    const typeByHash = overrideTypes(overrides, priorEntries);
    // Every column's type is resolved before any key is minted.
    /** @type {PlannedColumn[]} */
    const plan = kept.map((c, i) => {
        const type = declaredType(c, described[i], typeByHash, priorByHash, out.warnings);
        return { c, d: described[i], type, id: fieldIdFor(described[i].headerHash, type) };
    });
    const used = keysInUse(plan, declaredRelations, prior, reservedKeys);
    const seenIds = new Set();
    const hashesNow = new Set();
    let keyFieldId = null;
    for (const p of plan) {
        const keptField = prior.get(p.id);
        const key = columnKey(p, keptField, priorByHash, used);
        used.add(key);
        seenIds.add(p.id);
        hashesNow.add(p.d.headerHash);
        const { field, entry, isKey } = columnFieldAndEntry(p, key, keyCol);
        if (isKey) keyFieldId = p.id;
        out.fields.push(field);
        out.columnMap[p.id] = entry;
        out.changes.push(...columnChanges(keptField, priorEntries[p.id], field, p.c.col));
    }
    if (Number.isInteger(keyCol) && keyFieldId === null) {
        out.warnings.push(`The key column (column ${columnLetter(keyCol)}) is not in the header any more; rows are identified by row number until the owner picks another.`);
    }
    addRelationFields(declaredRelations, prior, used, seenIds, out);
    const retyped = droppedFields(prior, seenIds, hashesNow, out.changes);
    return { ...out, retyped, keyFieldId };
}

/**
 * Select options as distinct, trimmed, bounded strings.
 * @param {unknown} options
 */
function optionList(options) {
    const seen = new Set();
    const out = [];
    for (const o of Array.isArray(options) ? options : []) {
        const label = String(o && typeof o === 'object' ? (o.label ?? o.value ?? '') : (o ?? '')).trim().slice(0, DATA_LIMITS.MAX_NAME_LEN);
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
        if (out.length >= DATA_LIMITS.MAX_SELECT_OPTIONS) break;
    }
    return out;
}

module.exports = {
    ID_PREFIX,
    MATCH_PREFIX,
    INFERABLE_TYPES,
    DECLARABLE_TYPES,
    TYPE_CODE,
    columnLetter,
    headerText,
    slugOf,
    describeHeader,
    fieldIdFor,
    parseFieldId,
    matchFieldIdFor,
    keyFromTitle,
    optionList,
    fieldsFromSheet,
};
