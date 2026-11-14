// @typecheck strict
/**
 * The identity of a sheet column: header text → display name, slug, header
 * hash and field id (columns.js explains why the header text IS the identity).
 * PURE: no database, no network.
 */

'use strict';

const crypto = require('crypto');
const { DATA_LIMITS } = require('../../dataModel/vocabulary');
const { FIELD_ID_RE } = require('../../dataModel/datatableFields');
const { TYPE_CODE, matchFieldIdFor: matchFieldIdWith } = require('../mirror/keys');
const { isoDate } = require('./cells');

const ID_PREFIX = 'fld_ss';
const MATCH_PREFIX = 'fld_ssrel';
const HASH_LEN = 10;
const ID_RE = /^fld_ss([0-9a-f]{10})([a-z]{3})$/;

/**
 * 0 → 'A', 25 → 'Z', 26 → 'AA' — display only; the wire carries the 0-based `col`.
 * @param {unknown} col
 */
function columnLetter(col) {
    let n = Number(col);
    if (!Number.isInteger(n) || n < 0) return '';
    let s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
}

/**
 * The header cell as text: a Date header becomes its ISO date, a number its digits.
 * @param {unknown} cell
 */
function headerText(cell) {
    if (cell === null || cell === undefined) return '';
    if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : isoDate(cell);
    return String(cell).trim().slice(0, DATA_LIMITS.MAX_NAME_LEN);
}

/**
 * The keyFromTitle normalisation alone: lower-case ASCII with underscores, '' when nothing is left.
 * @param {unknown} header
 */
function slugOf(header) {
    return String(header ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_');
}

/** @param {string} seed */
function hashOf(seed) {
    return crypto.createHash('sha256').update(`ss\0${seed}`).digest('hex').slice(0, HASH_LEN);
}

/**
 * The identity and display facts of every header cell, in the order given.
 * Shared by infer.js (describe) and fieldsFromSheet (link/sync) so the wizard
 * and the pass agree on names, hashes and duplicate numbering.
 *
 * @param {Array<{col:number, header:*}>|Array<*>} cells   header cells, or {col, header} pairs
 * @returns {Array<{ col: number, letter: string, header: string, name: string, slug: string, headerHash: string, blankHeader: boolean, duplicateHeader: boolean }>}
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

/**
 * @param {string} headerHash
 * @param {string} type
 */
function fieldIdFor(headerHash, type) {
    const id = `${ID_PREFIX}${headerHash}${/** @type {Record<string, string>} */ (TYPE_CODE)[type] || 'txt'}`;
    if (!FIELD_ID_RE.test(id)) throw new Error(`spreadsheetFile: cannot derive a field id for header hash ${headerHash}`);
    return id;
}

/**
 * `fld_ss<hash><code>` → { headerHash, typeCode } or null.
 * @param {unknown} id
 */
function parseFieldId(id) {
    const m = ID_RE.exec(String(id || ''));
    return m ? { headerHash: m[1], typeCode: m[2] } : null;
}

/**
 * The declared-relation column: one id per (target, local, target field)
 * triple, the same hash as Nextcloud's, under this kind's prefix.
 * @param {string} targetDatatableId
 * @param {string} localFieldId
 * @param {string} targetFieldId
 */
function matchFieldIdFor(targetDatatableId, localFieldId, targetFieldId) {
    return matchFieldIdWith(targetDatatableId, localFieldId, targetFieldId, MATCH_PREFIX);
}

/**
 * The key a blank header gets: `col_c` for column C.
 * @param {{ blankHeader: boolean, letter: string, name: string }} described
 */
function keyTitleFor(described) {
    return described.blankHeader ? `col_${described.letter.toLowerCase()}` : described.name;
}

module.exports = {
    ID_PREFIX,
    MATCH_PREFIX,
    columnLetter,
    headerText,
    slugOf,
    describeHeader,
    fieldIdFor,
    parseFieldId,
    matchFieldIdFor,
    keyTitleFor,
};
