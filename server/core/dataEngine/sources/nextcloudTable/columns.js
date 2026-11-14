// @typecheck
/**
 * Nextcloud columns → datatable fields, deterministically.
 *
 * ── STABLE IDS, STABLE KEYS ─────────────────────────────────────────
 * The migration planner diffs models BY FIELD ID (dataModel/datatableFields.js
 * explains why at length), so a mirror's ids must survive every refresh and
 * every re-link: they are DERIVED — `fld_nc<columnId><type code>` — never
 * minted. The type code is part of the id on purpose: a column Nextcloud
 * RETYPES (text → number) then arrives with a NEW id, which is exactly what
 * the planner needs to see (an ADD), and schema.js pairs it with the DROP the
 * planner cannot emit by itself.
 *
 * The KEY is derived once, from the title, and then KEPT: automations, apps and
 * pages name a column by key, and a person renaming "Leverancier" to
 * "Supplier" in Nextcloud should not break every automation that reads it. The
 * display `name` follows the title; the key stays with the column id.
 *
 * ── RELATIONS ───────────────────────────────────────────────────────
 * Two kinds, both ending up as a `relation` field (no FK — index.js says why):
 *   'nc'    Nextcloud's own relation column, when its target table is ALSO
 *           linked in this scope. The value is the target's row id, which is
 *           the target mirror's `id`. A derived text column `<key>_label`
 *           rides beside it, filled from the target's label column, so a
 *           automation or a grid sees the name and not only the id. When the
 *           target is NOT linked the column arrives as a plain number.
 *   'match' Declared in Bee Flow: "column X of this table equals column Y of
 *           that mirror". The sync resolves it into `<target key>_ref`.
 *
 * PURE: no database, no network. sync.js and link.js feed it and act on
 * `changes`.
 */

'use strict';

const { DATA_LIMITS } = require('../../dataModel/vocabulary');
const { FIELD_ID_RE } = require('../../dataModel/datatableFields');
// The key normalisation, the type codes, the option-label bijection and the
// declared-relation id are every source's (../mirror/keys); re-exported below
// so appStudio/linkedTables.js and the tests keep importing them from here.
const { TYPE_CODE, keyFromTitle, optionLabels, matchFieldIdFor: matchFieldIdWith } = require('../mirror/keys');

/** Nextcloud (type, subtype) → the datatable field type the mirror stores. */
function mirrorTypeFor(ncType, ncSubtype) {
    const sub = ncSubtype || '';
    switch (ncType) {
        case 'text':
            if (sub === 'rich') return 'richtext';
            return 'text';            // line, long, link (JSON verbatim)
        case 'number':
            return 'number';          // '', progress, stars
        case 'datetime':
            if (sub === 'date') return 'date';
            if (sub === 'time') return 'text';
            return 'datetime';
        case 'selection':
            if (sub === 'check') return 'bool';
            if (sub === 'selection-multi') return 'multiselect';
            return 'select';
        case 'usergroup':
            return 'text';            // JSON verbatim — lossless round trip
        case 'relation':
            return 'relation';        // narrowed to number when the target is not linked
        default:
            return 'text';
    }
}

function fieldIdFor(ncColumnId, type) {
    const id = `fld_nc${Number(ncColumnId)}${TYPE_CODE[type] || 'txt'}`;
    if (!FIELD_ID_RE.test(id)) throw new Error(`nextcloudTable: cannot derive a field id for column ${ncColumnId}`);
    return id;
}

/** The derived label column beside an 'nc' relation. */
function labelFieldIdFor(ncColumnId) {
    return `fld_nc${Number(ncColumnId)}lbl`;
}

/** The declared-relation column: one id per (target, local, target field) triple. */
function matchFieldIdFor(targetDatatableId, localFieldId, targetFieldId) {
    return matchFieldIdWith(targetDatatableId, localFieldId, targetFieldId, 'fld_ncrel');
}

/** A mirror field id of one Nextcloud column: `fld_nc<columnId><type code>`. */
const NC_FIELD_ID_RE = /^fld_nc(\d+)[a-z]{3}$/;

/**
 * @typedef {{ fields: MirrorField[], columnMap: Record<string, ColumnEntry>, relations: MirrorRelation[], warnings: string[], changes: string[] }} NcFieldsOut
 * @typedef {{ linkedTargets: Map<number, string>, linkedViews: Map<number, string> }} Linked
 * @typedef {ReturnType<typeof relationTargetFor>} RelationTarget
 */

/**
 * The mirror's prior fields by id, and each Nextcloud column's prior field
 * under its PREVIOUS type code: a retype drops the old field and adds a new
 * one, but the key (what automations name) carries over, because to a person
 * it is still the same column.
 * @param {unknown} existingFields
 */
function priorFields(existingFields) {
    /** @type {Map<string, MirrorField>} */
    const prior = new Map((Array.isArray(existingFields) ? existingFields : [])
        .filter(f => f && typeof f.id === 'string').map(f => [f.id, f]));
    /** @type {Map<number, MirrorField>} */
    const priorByColumn = new Map();
    for (const f of prior.values()) {
        const m = NC_FIELD_ID_RE.exec(f.id);
        if (m && f.id !== labelFieldIdFor(m[1])) priorByColumn.set(Number(m[1]), f);
    }
    return { prior, priorByColumn };
}

/**
 * Keys already owned by columns and declared relations that STAY, reserved
 * first, so a new column titled like an old one does not steal its key.
 * @param {NcColumn[]} kept
 * @param {DeclaredRelation[]} declaredRelations
 * @param {Map<string, MirrorField>} prior
 * @param {Set<string>} reservedKeys
 * @param {Linked} linked
 */
function keysInUse(kept, declaredRelations, prior, reservedKeys, linked) {
    const used = new Set(reservedKeys);
    const ids = kept.map(c => fieldIdFor(c.id, relationNarrowed(c, mirrorTypeFor(c.type, c.subtype), linked.linkedTargets, linked.linkedViews)));
    for (const rel of declaredRelations) ids.push(matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId));
    for (const id of ids) {
        const k = prior.get(id);
        if (k && k.key) used.add(k.key);
    }
    return used;
}

/**
 * A column's mirror type; an nc relation whose target is not linked here
 * arrives as a plain number, with a warning.
 * @param {NcColumn} c
 * @param {Linked} linked
 * @param {string[]} warnings
 * @returns {{ type: string, relationTarget: RelationTarget }}
 */
function columnType(c, linked, warnings) {
    const type = mirrorTypeFor(c.type, c.subtype);
    if (type !== 'relation') return { type, relationTarget: null };
    const relationTarget = relationTargetFor(c, linked.linkedTargets, linked.linkedViews);
    if (relationTarget) return { type, relationTarget };
    warnings.push(`"${c.title}" links to a Nextcloud table that is not linked here, so it arrives as a plain number (the row id).`);
    return { type: 'number', relationTarget: null };
}

/**
 * A column's key: the kept one, else the key of the same column under its old
 * type when still free, else one minted from the title.
 * @param {NcColumn} c
 * @param {MirrorField | undefined} kept
 * @param {Map<number, MirrorField>} priorByColumn
 * @param {Set<string>} used
 */
function columnKey(c, kept, priorByColumn, used) {
    if (kept && kept.key) return kept.key;
    const retypedFrom = !kept ? priorByColumn.get(Number(c.id)) : null;
    if (retypedFrom && retypedFrom.key && !used.has(retypedFrom.key)) return retypedFrom.key;
    return keyFromTitle(c.title, c.id, used);
}

/**
 * One column's mirror field and column-map entry; a list column carries its
 * options, a relation its target (and its line in `relations`).
 * @param {NcColumn} c
 * @param {{ id: string, key: string, type: string, relationTarget: RelationTarget }} col
 * @param {NcFieldsOut} out
 */
function columnFieldAndEntry(c, { id, key, type, relationTarget }, out) {
    /** @type {MirrorField} */
    const field = { id, key, name: String(c.title || key).trim().slice(0, DATA_LIMITS.MAX_NAME_LEN) || key, type };
    /** @type {ColumnEntry} */
    const entry = { ncColumnId: c.id, ncType: c.type, ncSubtype: c.subtype || '', title: c.title };
    if (type === 'select' || type === 'multiselect') {
        const options = optionLabels(c.selectionOptions);
        if (!options.length) {
            // A list column with no options cannot be a select here (the
            // normaliser refuses one with none); its ids arrive as text.
            field.type = 'text';
            out.warnings.push(`"${c.title}" is a list column with no options in Nextcloud, so its values arrive as text.`);
        } else {
            field.options = options.map(o => o.label);
            entry.options = options;
        }
    }
    if (type === 'relation' && relationTarget) {
        field.relation = { table: relationTarget.datatableId, fk: false };
        entry.relation = { relationType: relationTarget.relationType, targetId: relationTarget.targetId, labelColumn: relationTarget.labelColumn };
        out.relations.push({
            fieldId: id, kind: 'nc',
            targetDatatableId: relationTarget.datatableId,
            labelFieldId: labelFieldIdFor(c.id),
            labelNcColumnId: relationTarget.labelColumn,
        });
    }
    if (c.mandatory) field.required = true;
    return { field, entry };
}

/**
 * The derived label column beside an nc relation.
 * @param {NcColumn} c
 * @param {MirrorField} field   the relation field it labels
 * @param {Map<string, MirrorField>} prior
 * @param {Set<string>} used
 * @param {NcFieldsOut} out
 */
function addLabelField(c, field, prior, used, out) {
    const lid = labelFieldIdFor(c.id);
    const lkept = prior.get(lid);
    const lkey = lkept && lkept.key ? lkept.key : keyFromTitle(`${c.title} label`, c.id, used);
    used.add(lkey);
    out.fields.push({ id: lid, key: lkey, name: `${field.name} (label)`, type: 'text', derived: true });
    out.columnMap[lid] = { derived: 'label', forFieldId: field.id };
    if (!lkept) out.changes.push(`added:${lkey}`);
    return lid;
}

/** @param {DeclaredRelation | null | undefined} rel */
const isDeclaredRelation = rel => Boolean(rel && rel.targetDatatableId && rel.localFieldId && rel.targetFieldId);

/**
 * Declared relations, after the source's columns so their keys never shadow one.
 * @param {DeclaredRelation[]} declaredRelations
 * @param {Map<string, MirrorField>} prior
 * @param {Set<string>} used
 * @param {Set<string>} seenIds
 * @param {NcFieldsOut} out
 */
function addDeclaredRelations(declaredRelations, prior, used, seenIds, out) {
    for (const rel of declaredRelations) {
        if (!isDeclaredRelation(rel)) continue;
        if (!seenIds.has(rel.localFieldId) && !prior.has(rel.localFieldId)) {
            out.warnings.push(`A declared relation names a column this table no longer has (${rel.localFieldId}); it is skipped.`);
            continue;
        }
        const id = matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId);
        const kept = prior.get(id);
        const key = kept && kept.key ? kept.key : keyFromTitle(`${rel.targetKey || 'related'}_ref`, 0, used);
        used.add(key);
        seenIds.add(id);
        out.fields.push({
            id, key,
            name: kept && kept.name ? kept.name : `${rel.targetName || rel.targetKey || 'Related'} row`,
            type: 'relation', derived: true,
            relation: { table: rel.targetDatatableId, fk: false },
        });
        out.columnMap[id] = { derived: 'match', localFieldId: rel.localFieldId, targetFieldId: rel.targetFieldId };
        out.relations.push({ fieldId: id, kind: 'match', targetDatatableId: rel.targetDatatableId, localFieldId: rel.localFieldId, targetFieldId: rel.targetFieldId });
        if (!kept) out.changes.push(`added:${key}`);
    }
}

/**
 * What the previous shape had and this one does not — a column Nextcloud
 * dropped, or one it retyped (same column id, new type code, new field id).
 * Returns the retyped fields.
 * @param {Map<string, MirrorField>} prior
 * @param {Set<string>} seenIds
 * @param {NcColumn[]} cols
 * @param {string[]} changes
 */
function droppedFields(prior, seenIds, cols, changes) {
    const retyped = [];
    for (const old of prior.values()) {
        if (seenIds.has(old.id)) continue;
        const m = NC_FIELD_ID_RE.exec(old.id);
        const sameColumnStillThere = m && cols.some(c => Number(c.id) === Number(m[1]));
        if (sameColumnStillThere) { retyped.push(old); changes.push(`retyped:${old.key}`); }
        else changes.push(`removed:${old.key}`);
    }
    return retyped;
}

/**
 * @param {Array} ncColumns   describeColumn() objects, in table order
 * @param {{ existingFields?: Array, linkedTargets?: Map<number,string>, linkedViews?: Map<number,string>,
 *   declaredRelations?: Array, reservedKeys?: Set<string> }} [ctx] `existingFields`: the mirror's
 *   current fields (identity + kept keys); `linkedTargets`: ncTableId → datatableId of every mirror in
 *   scope; `linkedViews`: ncViewId → datatableId (a relation may target a view); `declaredRelations`:
 *   [{ targetDatatableId, targetKey, localFieldId, targetFieldId }]; `reservedKeys`: keys this mirror
 *   must not use (none today; hook for callers)
 * @returns {{ fields:Array, columnMap:object, relations:Array, warnings:string[], changes:string[], retyped:Array }}
 */
function fieldsFromNcColumns(ncColumns, {
    existingFields = [], linkedTargets = new Map(), linkedViews = new Map(),
    declaredRelations = [], reservedKeys = new Set(),
} = {}) {
    const linked = { linkedTargets, linkedViews };
    const { prior, priorByColumn } = priorFields(existingFields);
    /** @type {NcFieldsOut} */
    const out = { fields: [], columnMap: {}, relations: [], warnings: [], changes: [] };
    const seenIds = new Set();

    const cols = (Array.isArray(ncColumns) ? ncColumns : []).filter(c => c && Number.isInteger(Number(c.id)));
    if (cols.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
        out.warnings.push(`Only the first ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} of ${cols.length} columns are mirrored.`);
    }
    const kept = cols.slice(0, DATA_LIMITS.MAX_FIELDS_PER_TABLE);
    const used = keysInUse(kept, declaredRelations, prior, reservedKeys, linked);

    for (const c of kept) {
        const { type, relationTarget } = columnType(c, linked, out.warnings);
        const id = fieldIdFor(c.id, type);
        const keptField = prior.get(id);
        const key = columnKey(c, keptField, priorByColumn, used);
        used.add(key);
        seenIds.add(id);
        const { field, entry } = columnFieldAndEntry(c, { id, key, type, relationTarget }, out);
        out.fields.push(field);
        out.columnMap[id] = entry;
        if (!keptField) out.changes.push(`added:${key}`);
        else if (keptField.name !== field.name) out.changes.push(`renamed:${key}`);
        if (type === 'relation') seenIds.add(addLabelField(c, field, prior, used, out));
    }

    addDeclaredRelations(declaredRelations, prior, used, seenIds, out);
    const retyped = droppedFields(prior, seenIds, cols, out.changes);
    return { ...out, retyped };
}

/** For an nc relation: the linked mirror it points at, or null. */
function relationTargetFor(c, linkedTargets, linkedViews) {
    const cs = c.customSettings || {};
    const relationType = cs.relationType === 'view' ? 'view' : 'table';
    const targetId = Number(cs.targetId);
    const labelColumn = Number(cs.labelColumn);
    if (!Number.isInteger(targetId) || !Number.isInteger(labelColumn)) return null;
    const datatableId = relationType === 'view' ? linkedViews.get(targetId) : linkedTargets.get(targetId);
    if (!datatableId) return null;
    return { relationType, targetId, labelColumn, datatableId };
}

function relationNarrowed(c, type, linkedTargets, linkedViews) {
    if (type !== 'relation') return type;
    return relationTargetFor(c, linkedTargets, linkedViews) ? 'relation' : 'number';
}

module.exports = {
    mirrorTypeFor,
    fieldIdFor,
    labelFieldIdFor,
    matchFieldIdFor,
    keyFromTitle,
    optionLabels,
    fieldsFromNcColumns,
    TYPE_CODE,
};

/**
 * @typedef {{ id: number | string, type?: string, subtype?: string, title?: string, mandatory?: boolean,
 *   selectionOptions?: Array<{ id: number | string, label?: unknown }>,
 *   customSettings?: { relationType?: string, targetId?: unknown, labelColumn?: unknown } }} NcColumn
 * @typedef {{ id: string, key: string, name?: string, type?: string, options?: string[],
 *   relation?: { table: string, fk: boolean }, required?: boolean, derived?: boolean }} MirrorField
 * @typedef {{ ncColumnId?: number | string, ncType?: string, ncSubtype?: string, title?: string,
 *   options?: Array<{ id: number | string, label: string }>,
 *   relation?: { relationType: string, targetId: number, labelColumn: number },
 *   derived?: string, forFieldId?: string, localFieldId?: string, targetFieldId?: string }} ColumnEntry
 * @typedef {{ targetDatatableId: string, targetKey?: string, targetName?: string, localFieldId: string, targetFieldId: string }} DeclaredRelation
 * @typedef {{ fieldId: string, kind: string, targetDatatableId: string, labelFieldId?: string, labelNcColumnId?: number,
 *   localFieldId?: string, targetFieldId?: string }} MirrorRelation
 */
