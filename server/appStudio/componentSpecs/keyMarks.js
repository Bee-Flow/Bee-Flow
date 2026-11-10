// @typecheck strict
/**
 * App Studio catalog — the `since` marks of keys that have no spec table of their own.
 *
 * A component prop, a style knob, a step field, a screen key and a theme or design key each sit
 * in a table, and carry `since: 3` on their own entry. A SECTION key, a NODE key beside props
 * and style (a logic key, an event), a NAV key and a nav GROUP key are cleaned by hand-written
 * code, so there is nothing to put the mark on. This registry is where it goes: one file per
 * key, `keys/<family>/<key>.js`, the file name being the key exactly as a definition spells it.
 *
 *   module.exports = {
 *       since: 3,                      // a NEW key (leave out for a base key that gained values)
 *       valuesSince: { compact: 3 },   // optional: enum values added to the key after the base
 *       shape: 'string ≤80',           // the value, as catalogue text (not for sectionStyle)
 *       description: 'A title shown above the section. Empty hides it.',
 *   };
 *
 * Families:
 *   section       a key of a section beside id, style and children
 *   sectionStyle  a style knob (of STYLE_KNOBS) a section may newly carry; shape comes from the knob
 *   node          a key of a component node beside id, type, props, style and children
 *   nav           a key of definition.nav
 *   navGroup      a key of one entry of definition.nav.groups
 *   binding       a key a record, records, aggregate or dataset binding newly takes
 *   queryShape    a form the value under a binding key newly takes (file <key>.<name>.js)
 *
 * The last two describe a data read and carry more than a mark (the function the canonicalizer
 * keeps the key with, the predicate that recognises the form): queryMarks.js says what.
 *
 * What a mark does: a definition that uses the key (or the value) is stored with at least that
 * schemaVersion (schemaSince.mts), and the AI builder lists it in its extension index and
 * serves `shape — description` through app_inspect_catalog (catalogTiers.mts). The mark does
 * NOT make the key legal: the canonicalizer and the validator still have to keep it.
 *
 * The directories ship empty. Plain .js like the rest of componentSpecs.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { requireSince } = require('./registryDir');
const { bindingMarkProblems, queryShapeProblems } = require('./queryMarks');

const KEYS_DIR = path.join(__dirname, 'keys');
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * The families and the keys each had in the frozen base. A file with `since` may not claim one
 * of these; a file with only `valuesSince` must name one.
 */
const KEY_MARK_FAMILIES = Object.freeze({
    section: Object.freeze(['id', 'style', 'children']),
    sectionStyle: Object.freeze(['padding', 'gap', 'background', 'height', 'heightMode', 'heightValue']),
    node: Object.freeze([
        'id', 'type', 'props', 'style', 'visible', 'children',
        'visibleWhen', 'enabledWhen', 'readOnly', 'computed', 'validations', 'visibleToRoles',
        'onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange', 'onDecided', 'onAttachmentClick',
    ]),
    nav: Object.freeze(['style', 'groups']),
    navGroup: Object.freeze(['id', 'label', 'icon', 'screens']),
    // The base keys of a binding differ per kind, and a query shape is not a key: queryMarks.js holds both.
    binding: Object.freeze([]),
    queryShape: Object.freeze([]),
});

/** The families whose files are checked by their own rules (queryMarks.js). */
const QUERY_MARK_PROBLEMS = Object.freeze({ binding: bindingMarkProblems, queryShape: queryShapeProblems });

/** @typedef {keyof typeof KEY_MARK_FAMILIES} KeyMarkFamily */
/** @typedef {{ since?: number, valuesSince?: Record<string, number>, shape?: string, description: string, kinds?: readonly string[], holds?: string, entryKey?: boolean, clean?: (value: unknown, ctx: import('./queryMarks').CleanContext) => unknown, uses?: (value: unknown) => boolean }} KeyMark */
/** @typedef {Record<KeyMarkFamily, Record<string, KeyMark>>} KeyMarks */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `since` as a problem sentence, or null when it is an integer of 3 or more.
 * @param {unknown} since
 * @param {string} where
 * @returns {string | null}
 */
function sinceProblem(since, where) {
    try {
        requireSince(since, where);
        return null;
    } catch (e) {
        return /** @type {Error} */ (e).message;
    }
}

/**
 * What is wrong with the marks themselves: which of `since` / `valuesSince` a key may carry.
 * @param {Record<string, unknown>} mark
 * @param {boolean} isBase  the key is one the family had in the frozen base
 * @param {string} where
 * @returns {Array<string | null>}
 */
function sinceProblems(mark, isBase, where) {
    const hasValues = mark.valuesSince !== undefined;
    /** @type {Array<string | null>} */
    const out = [];
    if (mark.since === undefined) {
        if (!hasValues) out.push(`${where}: carries "since" (a new key) or "valuesSince" (values added to a base key)`);
        else if (!isBase) out.push(`${where}: not a base key of its family, so it needs its own "since"`);
    } else {
        out.push(sinceProblem(mark.since, where));
        if (isBase) out.push(`${where}: a base key of its family; only "valuesSince" can mark it`);
    }
    if (hasValues) {
        const values = isObject(mark.valuesSince) ? Object.entries(mark.valuesSince) : [];
        if (!values.length) out.push(`${where}: "valuesSince" is { <value>: <since> } with at least one value`);
        for (const [value, since] of values) out.push(sinceProblem(since, `${where} (value ${value})`));
    }
    return out;
}

/**
 * Why `mark` is not a usable mark for `family`.`key`, as sentences; empty when it is.
 * @param {string} family
 * @param {string} key
 * @param {unknown} mark
 * @returns {string[]}
 */
function keyMarkProblems(family, key, mark) {
    const where = `keys/${family}/${key}.js`;
    const base = Object.hasOwn(KEY_MARK_FAMILIES, family) ? KEY_MARK_FAMILIES[/** @type {KeyMarkFamily} */ (family)] : null;
    if (!base) return [`${where}: "${family}" is not a family (${Object.keys(KEY_MARK_FAMILIES).join(', ')})`];
    if (Object.hasOwn(QUERY_MARK_PROBLEMS, family)) return QUERY_MARK_PROBLEMS[/** @type {keyof typeof QUERY_MARK_PROBLEMS} */ (family)](key, mark);
    if (!KEY_NAME.test(key)) return [`${where}: the file is named after the key (letters, digits, underscores; at most 40)`];
    if (!isObject(mark)) return [`${where}: must export an object`];
    const out = sinceProblems(mark, base.includes(key), where);
    if (typeof mark.description !== 'string' || !mark.description.trim()) out.push(`${where}: "description" says in one sentence what the key does`);
    if (family !== 'sectionStyle' && (typeof mark.shape !== 'string' || !mark.shape.trim())) out.push(`${where}: "shape" gives the value's shape as catalogue text`);
    return /** @type {string[]} */ (out.filter(Boolean));
}

/**
 * The `.js` files of one family directory, sorted, as [key, file].
 * @param {string} dir
 * @returns {Array<[string, string]>}
 */
function familyFiles(dir) {
    /** @type {string[]} */
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' || /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOTDIR') return [];
        throw e;
    }
    return entries
        .filter((entry) => entry.endsWith('.js') && !entry.endsWith('.test.js'))
        .sort()
        .map((entry) => [entry.slice(0, -'.js'.length), path.join(dir, entry)]);
}

/**
 * Every mark under `dir`, per family, in file-name order. A missing directory is an empty
 * registry. Throws on the first file that is not a complete mark, and on a directory that is
 * not a family.
 * @param {string} [dir]
 * @returns {KeyMarks}
 */
function loadKeyMarks(dir = KEYS_DIR) {
    const out = /** @type {KeyMarks} */ (Object.create(null));
    for (const family of Object.keys(KEY_MARK_FAMILIES)) out[/** @type {KeyMarkFamily} */ (family)] = Object.create(null);
    /** @type {string[]} */
    let families = [];
    try {
        families = fs.readdirSync(dir).filter((name) => !name.includes('.')).sort();
    } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    }
    for (const family of families) {
        if (!Object.hasOwn(KEY_MARK_FAMILIES, family)) throw new Error(`Key marks: keys/${family}/ is not a family (${Object.keys(KEY_MARK_FAMILIES).join(', ')})`);
        for (const [key, file] of familyFiles(path.join(dir, family))) {
            const mark = require(file);
            const problems = keyMarkProblems(family, key, mark);
            if (problems.length) throw new Error(`Key marks: ${problems.join('; ')}`);
            out[/** @type {KeyMarkFamily} */ (family)][key] = mark;
        }
    }
    return out;
}

/** The shipped marks. Read once: the registry is fixed after load. */
const KEY_MARKS = loadKeyMarks();

module.exports = { KEYS_DIR, KEY_MARK_FAMILIES, KEY_MARKS, loadKeyMarks, keyMarkProblems };
