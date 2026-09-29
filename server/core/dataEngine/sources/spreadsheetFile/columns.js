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
 * The KEY is derived once, from the header, and then KEPT (routines and apps
 * name a column by key). A formula column is `derived: true` — read-only,
 * its value is the file's cached result. Declared `match` relations are the
 * same shape as Nextcloud's, under the `fld_ssrel` prefix.
 *
 * PURE: no database, no network. link.js and sync.js feed it and act on
 * `changes` / `retyped`.
 */

'use strict';

const crypto = require('crypto');
const { DATA_LIMITS } = require('../../dataModel/vocabulary');
const { FIELD_ID_RE } = require('../../dataModel/datatableFields');
const { keyFromTitle, TYPE_CODE, matchFieldIdFor: matchFieldIdWith } = require('../mirror/keys');
const { formatOfNumFmt, isoDate } = require('./cells');

const ID_PREFIX = 'fld_ss';
const MATCH_PREFIX = 'fld_ssrel';
const HASH_LEN = 10;
const ID_RE = /^fld_ss([0-9a-f]{10})([a-z]{3})$/;

/** What infer.js may conclude from cells. */
const INFERABLE_TYPES = Object.freeze(['text', 'number', 'date', 'datetime', 'bool']);
/** What the wizard / `PUT /:id/source` may declare (select is the one opt-in). */
const DECLARABLE_TYPES = Object.freeze([...INFERABLE_TYPES, 'select']);

/** 0 → 'A', 25 → 'Z', 26 → 'AA' — display only; the wire carries the 0-based `col`. */
function columnLetter(col) {
    let n = Number(col);
    if (!Number.isInteger(n) || n < 0) return '';
    let s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
}

/** The header cell as text: a Date header becomes its ISO date, a number its digits. */
function headerText(cell) {
    if (cell === null || cell === undefined) return '';
    if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : isoDate(cell);
    return String(cell).trim().slice(0, DATA_LIMITS.MAX_NAME_LEN);
}

/** The keyFromTitle normalisation alone: lower-case ASCII with underscores, '' when nothing is left. */
function slugOf(header) {
    return String(header ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_');
}

function hashOf(seed) {
    return crypto.createHash('sha256').update(`ss\0${seed}`).digest('hex').slice(0, HASH_LEN);
}

/**
 * The identity and display facts of every header cell, in the order given.
 * Shared by infer.js (describe) and fieldsFromSheet (link/sync) so the wizard
 * and the pass agree on names, hashes and duplicate numbering.
 *
 * @param {Array<{col:number, header:*}>|Array<*>} cells   header cells, or {col, header} pairs
 * @returns {Array<{ col, letter, header, name, slug, headerHash, blankHeader, duplicateHeader }>}
 */
function describeHeader(cells) {
    const list = (Array.isArray(cells) ? cells : []).map((c, i) => (
        c && typeof c === 'object' && !(c instanceof Date) && 'header' in c
            ? { col: Number.isInteger(c.col) ? c.col : i, raw: c.header }
            : { col: i, raw: c }
    ));
    const seenSlugs = new Map();     // slug → occurrences so far
    return list.map(({ col, raw }) => {
        const header = headerText(raw);
        const letter = columnLetter(col);
        const blankHeader = header === '';
        const slug = blankHeader ? '' : slugOf(header);
        const occurrence = blankHeader ? 0 : (seenSlugs.get(slug) || 0) + 1;
        if (!blankHeader) seenSlugs.set(slug, occurrence);
        const duplicateHeader = occurrence > 1;
        const seed = blankHeader ? `#col${col}` : duplicateHeader ? `${slug}#${col}` : slug;
        const name = blankHeader ? letter : duplicateHeader ? `${header} #${occurrence}` : header;
        return { col, letter, header, name, slug, headerHash: hashOf(seed), blankHeader, duplicateHeader };
    });
}

function fieldIdFor(headerHash, type) {
    const id = `${ID_PREFIX}${headerHash}${TYPE_CODE[type] || 'txt'}`;
    if (!FIELD_ID_RE.test(id)) throw new Error(`spreadsheetFile: cannot derive a field id for header hash ${headerHash}`);
    return id;
}

/** `fld_ss<hash><code>` → { headerHash, typeCode } or null. */
function parseFieldId(id) {
    const m = ID_RE.exec(String(id || ''));
    return m ? { headerHash: m[1], typeCode: m[2] } : null;
}

/**
 * The declared-relation column: one id per (target, local, target field)
 * triple, the same hash as Nextcloud's, under this kind's prefix.
 */
function matchFieldIdFor(targetDatatableId, localFieldId, targetFieldId) {
    return matchFieldIdWith(targetDatatableId, localFieldId, targetFieldId, MATCH_PREFIX);
}

/** The key a blank header gets: `col_c` for column C. */
function keyTitleFor(described) {
    return described.blankHeader ? `col_${described.letter.toLowerCase()}` : described.name;
}

/**
 * @param {Array} columns   [{ col, header, type?, formula?, options?, numFmt?, format?, dateFormat? }] in sheet order
 * @param {object} [ctx]
 * @param {Array}  [ctx.existingFields]      the mirror's current fields (identity + kept keys)
 * @param {object} [ctx.existingColumnMap]   the mirror's current source.columnMap (prior cols, types, hashes)
 * @param {Array}  [ctx.declaredRelations]   [{ targetDatatableId, targetKey, targetName, localFieldId, targetFieldId }]
 * @param {number|null} [ctx.keyCol]         0-based column of the key column (required:true)
 * @param {object} [ctx.overrides]           { [fieldId|headerHash]: { type } } — retypes from the wizard / PUT /:id/source
 * @param {Set<string>} [ctx.reservedKeys]   keys this mirror must not use
 * @returns {{ fields:Array, columnMap:object, relations:Array, warnings:string[], changes:string[], retyped:Array, keyFieldId:string|null }}
 */
function fieldsFromSheet(columns, {
    existingFields = [], existingColumnMap = {}, declaredRelations = [],
    keyCol = null, overrides = {}, reservedKeys = new Set(),
} = {}) {
    const prior = new Map((Array.isArray(existingFields) ? existingFields : [])
        .filter(f => f && typeof f.id === 'string').map(f => [f.id, f]));
    const priorEntries = existingColumnMap && typeof existingColumnMap === 'object' ? existingColumnMap : {};
    // The same header under its PREVIOUS type code: a retype drops the old
    // field and adds a new one, but the key — what routines name — carries
    // over, because to a person it is still the same column.
    const priorByHash = new Map();
    for (const [id, entry] of Object.entries(priorEntries)) {
        if (!entry || entry.derived) continue;
        const parsed = parseFieldId(id);
        const hash = entry.headerHash || (parsed && parsed.headerHash);
        if (hash) priorByHash.set(hash, { id, entry, field: prior.get(id) || null });
    }
    for (const f of prior.values()) {
        const parsed = parseFieldId(f.id);
        if (parsed && !priorByHash.has(parsed.headerHash)) priorByHash.set(parsed.headerHash, { id: f.id, entry: null, field: f });
    }

    const warnings = [];
    const cols = (Array.isArray(columns) ? columns : []).filter(c => c && Number.isInteger(c.col) && c.col >= 0);
    if (cols.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
        warnings.push(`Only the first ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} of ${cols.length} columns are mirrored.`);
    }
    const kept = cols.slice(0, DATA_LIMITS.MAX_FIELDS_PER_TABLE);
    const described = describeHeader(kept.map(c => ({ col: c.col, header: c.header })));

    // Overrides arrive keyed by the field id the caller knows (the OLD id of
    // a retyped column) or by header hash; both resolve to a hash.
    const typeByHash = new Map();
    for (const [k, v] of Object.entries(overrides || {})) {
        const type = v && typeof v === 'object' ? v.type : v;
        if (!DECLARABLE_TYPES.includes(type)) continue;
        const entry = priorEntries[k];
        const hash = (entry && entry.headerHash) || (parseFieldId(k) || {}).headerHash || (/^[0-9a-f]{10}$/.test(k) ? k : null);
        if (hash) typeByHash.set(hash, type);
    }

    // Resolve every column's declared type before minting anything, so keys
    // already owned by columns that STAY are reserved first (a new column
    // titled like an old one must not steal its key).
    const plan = kept.map((c, i) => {
        const d = described[i];
        let type = typeByHash.get(d.headerHash)
            || (DECLARABLE_TYPES.includes(c.type) ? c.type : null)
            || (priorByHash.get(d.headerHash) && priorByHash.get(d.headerHash).entry && priorByHash.get(d.headerHash).entry.type)
            || null;
        if (c.type && !DECLARABLE_TYPES.includes(c.type) && !typeByHash.has(d.headerHash)) {
            warnings.push(`"${d.name}" cannot be a ${c.type} column here; it arrives as text.`);
            type = 'text';
        }
        if (!type) type = 'text';
        if (type === 'select') {
            const options = optionList(c.options);
            if (!options.length) {
                warnings.push(`"${d.name}" is a list column without options, so its values arrive as text.`);
                type = 'text';
            }
        }
        return { c, d, type, id: fieldIdFor(d.headerHash, type) };
    });

    const used = new Set(reservedKeys);
    for (const p of plan) {
        const k = prior.get(p.id);
        if (k && k.key) used.add(k.key);
    }
    for (const rel of declaredRelations) {
        if (!rel || !rel.targetDatatableId || !rel.localFieldId || !rel.targetFieldId) continue;
        const k = prior.get(matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId));
        if (k && k.key) used.add(k.key);
    }

    const fields = [];
    const columnMap = {};
    const relations = [];
    const changes = [];
    const seenIds = new Set();
    const hashesNow = new Set();
    let keyFieldId = null;

    for (const { c, d, type, id } of plan) {
        const keptField = prior.get(id);
        const priorSame = priorByHash.get(d.headerHash);
        const retypedFrom = !keptField && priorSame && priorSame.field && priorSame.id !== id ? priorSame.field : null;
        const key = keptField && keptField.key ? keptField.key
            : (retypedFrom && retypedFrom.key && !used.has(retypedFrom.key)) ? retypedFrom.key
                : keyFromTitle(keyTitleFor(d), c.col + 1, used);
        used.add(key);
        seenIds.add(id);
        hashesNow.add(d.headerHash);

        const field = { id, key, name: d.name || key, type };
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
        if (Number.isInteger(keyCol) && keyCol === c.col) {
            field.required = true;
            entry.key = true;
            keyFieldId = id;
        }
        fields.push(field);
        columnMap[id] = entry;

        const priorEntry = priorEntries[id];
        if (!keptField) changes.push(`added:${key}`);
        else {
            if (keptField.name !== field.name) changes.push(`renamed:${key}`);
            if (priorEntry && Number.isInteger(priorEntry.col) && priorEntry.col !== c.col) changes.push(`moved:${key}`);
        }
    }

    if (Number.isInteger(keyCol) && keyFieldId === null) {
        warnings.push(`The key column (column ${columnLetter(keyCol)}) is not in the header any more; rows are identified by row number until the owner picks another.`);
    }

    // Declared relations, after the sheet's columns so their keys never
    // shadow one.
    for (const rel of declaredRelations) {
        if (!rel || !rel.targetDatatableId || !rel.localFieldId || !rel.targetFieldId) continue;
        if (!seenIds.has(rel.localFieldId) && !prior.has(rel.localFieldId)) {
            warnings.push(`A declared relation names a column this table no longer has (${rel.localFieldId}); it is skipped.`);
            continue;
        }
        const id = matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId);
        const keptField = prior.get(id);
        const key = keptField && keptField.key ? keptField.key : keyFromTitle(`${rel.targetKey || 'related'}_ref`, 0, used);
        used.add(key);
        seenIds.add(id);
        fields.push({
            id, key,
            name: keptField && keptField.name ? keptField.name : `${rel.targetName || rel.targetKey || 'Related'} row`,
            type: 'relation', derived: true,
            relation: { table: rel.targetDatatableId, fk: false },
        });
        columnMap[id] = { derived: 'match', localFieldId: rel.localFieldId, targetFieldId: rel.targetFieldId };
        relations.push({
            fieldId: id, kind: 'match',
            targetDatatableId: rel.targetDatatableId,
            localFieldId: rel.localFieldId,
            targetFieldId: rel.targetFieldId,
        });
        if (!keptField) changes.push(`added:${key}`);
    }

    // What the previous shape had and this one does not — a header that is
    // gone (or renamed: same thing, to us), or a column retyped (same header
    // hash, new type code, new field id).
    const retyped = [];
    for (const old of prior.values()) {
        if (seenIds.has(old.id)) continue;
        const parsed = parseFieldId(old.id);
        if (parsed && hashesNow.has(parsed.headerHash)) { retyped.push(old); changes.push(`retyped:${old.key}`); }
        else changes.push(`removed:${old.key}`);
    }

    return { fields, columnMap, relations, warnings, changes, retyped, keyFieldId };
}

/** Select options as distinct, trimmed, bounded strings. */
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
