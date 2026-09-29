/**
 * Naming a mirrored column, the same way for every kind.
 *
 * A source column becomes a datatable field with a KEY (what routines, apps
 * and pages name it by — derived once from the title, then kept) and an ID
 * (what the migration planner diffs by — derived, never minted, and carrying
 * the type code so a retype at the source arrives as a NEW id). The id
 * scheme itself is the adapter's (`fld_nc<columnId>…` for Nextcloud,
 * `fld_ss<hash>…` for a sheet); what is shared is the key normalisation, the
 * type codes, the option-label bijection and the declared-relation id.
 *
 * PURE: no database, no network.
 */

'use strict';

const crypto = require('crypto');
const {
    KEY_RE, RESERVED_KEY_PREFIX_RE, SYSTEM_COLUMNS, DATA_LIMITS,
} = require('../../dataModel/vocabulary');

// Three letters of the MIRROR type, so a retype changes the id.
const TYPE_CODE = Object.freeze({
    text: 'txt', richtext: 'rtx', number: 'num', date: 'dat', datetime: 'dtm',
    bool: 'bol', select: 'sel', multiselect: 'msl', relation: 'rel', file: 'fil',
});

/**
 * The declared-relation column: one id per (target, local, target field)
 * triple. `prefix` is the kind's own (`fld_ncrel`, `fld_ssrel`) so two kinds
 * cannot mint the same id for different triples.
 */
function matchFieldIdFor(targetDatatableId, localFieldId, targetFieldId, prefix = 'fld_ncrel') {
    const h = crypto.createHash('sha256').update(`${targetDatatableId}\0${localFieldId}\0${targetFieldId}`).digest('hex').slice(0, 10);
    return `${prefix}${h}`;
}

/**
 * A column title as a key: lower-case ASCII, underscores, within KEY_RE,
 * clear of the system columns and the engines' reserved prefixes, and unique
 * among `used`. "Excl. btw" → excl_btw; "2024 Q1" → c_2024_q1; "" → column_7.
 * `seed` is what names a titleless column (a column id, a position).
 */
function keyFromTitle(title, seed, used) {
    let key = String(title ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_');
    if (!key) key = `column_${Number(seed) || 0}`;
    if (!/^[a-z]/.test(key)) key = `c_${key}`;
    if (RESERVED_KEY_PREFIX_RE.test(key)) key = `c_${key}`;
    key = key.slice(0, 55);   // room for a _NN suffix inside 63
    if (SYSTEM_COLUMNS.includes(key)) key = `${key}_col`;
    if (!KEY_RE.test(key)) key = `column_${Number(seed) || 0}`;
    let candidate = key;
    let n = 2;
    while (used.has(candidate)) { candidate = `${key}_${n}`; n += 1; }
    return candidate;
}

/** Option labels, de-duplicated so id↔label is a bijection ("open", "open (2)"). */
function optionLabels(selectionOptions) {
    const seen = new Set();
    const out = [];
    for (const o of Array.isArray(selectionOptions) ? selectionOptions : []) {
        let label = String(o.label ?? '').trim().slice(0, DATA_LIMITS.MAX_NAME_LEN);
        if (!label) label = `option ${o.id}`;
        let candidate = label;
        let n = 2;
        while (seen.has(candidate)) { candidate = `${label} (${n})`; n += 1; }
        seen.add(candidate);
        out.push({ id: o.id, label: candidate });
        if (out.length >= DATA_LIMITS.MAX_SELECT_OPTIONS) break;
    }
    return out;
}

module.exports = { TYPE_CODE, matchFieldIdFor, keyFromTitle, optionLabels };
