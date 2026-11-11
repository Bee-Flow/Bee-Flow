// @typecheck strict
/**
 * App Studio catalog — the two key-mark families of a data read (keyMarks.js loads them with
 * the others, from the same folder):
 *
 *   keys/binding/<key>.js            a KEY a record, records, aggregate or dataset binding newly takes
 *   keys/queryShape/<on>.<name>.js   a FORM the value under the key <on> newly takes, where there is
 *                                    no key of the binding to mark: a nested group in a filter, a
 *                                    relation path as a clause field, a key of a groupBy entry
 *
 *   // keys/binding/search.js
 *   module.exports = {
 *       since: 3,
 *       kinds: ['record', 'records'],        // optional: the binding kinds that take the key (default: all four)
 *       shape: 'string ≤200',
 *       description: 'Free text matched against every text column.',
 *       clean: (value) => (typeof value === 'string' ? value.slice(0, 200) : undefined),
 *       holds: 'filter',                     // optional: the value is a clause list, read like `filter`
 *   };
 *
 *   // keys/queryShape/filter.nestedGroups.js: a predicate
 *   module.exports = {
 *       since: 3,
 *       shape: '{ all: [clause | group] } | { any: […] } | { not: clause | group }',
 *       description: 'Groups inside groups, to any depth.',
 *       uses: (filter) => Array.isArray(filter) && filter.some(isNestedGroup),
 *   };
 *
 *   // keys/queryShape/groupBy.relatedField.js: a key of the entries of a list the canonicalizer rebuilds
 *   module.exports = {
 *       since: 3,
 *       entryKey: true,                      // the name after the dot IS the key
 *       shape: 'string (a field of the related table)',
 *       description: 'Groups by a field of the row a relation points at.',
 *       clean: (value) => (typeof value === 'string' && value ? value : undefined),
 *   };
 *
 * What the marks do, beside what every key mark does (schema version, extension index):
 *   - `clean` is how the canonicalizer keeps the key (canonicalize/markedKeys.js): it is handed
 *     the authored value and answers the canonical one, or undefined to drop the key. It must be
 *     pure, total and idempotent (clean(clean(v)) equals clean(v)); it never sees null or
 *     undefined: an absent key stays absent.
 *   - `uses` answers whether the value under <on> has the form. Pure and total: it is handed
 *     whatever a definition holds there (a formula string, a number, a malformed list) and
 *     answers false for everything that is not the form, the base forms included.
 *
 * LAYER: literals only; keyMarks.js, schemaSince.mts and canonicalize/ read it.
 */

'use strict';

const { requireSince } = require('./registryDir');

/** The binding kinds that read rows: the ones a binding key can be marked on. */
const QUERY_BINDING_KINDS = Object.freeze(['record', 'records', 'aggregate', 'dataset']);

/** Per kind, the keys the frozen base canonicalizer reads. A mark cannot claim one of these for that kind. */
const BINDING_BASE_KEYS = Object.freeze({
    record: Object.freeze(['kind', 'tableId', 'path', 'filter', 'sort', 'limit', 'pick', 'recordId']),
    records: Object.freeze(['kind', 'tableId', 'filter', 'sort', 'limit', 'pick']),
    aggregate: Object.freeze(['kind', 'tableId', 'filter', 'sort', 'limit', 'groupBy', 'aggregates', 'pick']),
    dataset: Object.freeze(['kind', 'datasetId', 'params', 'pick']),
});

/** The keys a query shape can sit under: the structured values of a read. */
const QUERY_SHAPE_KEYS = Object.freeze(['filter', 'sort', 'groupBy', 'aggregates', 'params']);

/** The lists the canonicalizer rebuilds entry by entry, with the keys an entry had in the base. */
const ENTRY_BASE_KEYS = Object.freeze({
    groupBy: Object.freeze(['field', 'bucket', 'as']),
    aggregates: Object.freeze(['fn', 'field', 'as']),
});

/** Other base keys that hold the same value as a shape key: a write's `replaceWhere` is a clause list too. */
const SAME_VALUE_KEYS = Object.freeze({ filter: Object.freeze(['replaceWhere']) });

/**
 * @typedef {{ path: string, push: (code: string, path: string, message: string) => void, kind?: string }} CleanContext
 * @typedef {{ since: number, kinds?: readonly string[], shape: string, description: string, holds?: string, clean: (value: unknown, ctx: CleanContext) => unknown }} BindingKeyMark
 * @typedef {{ since: number, shape: string, description: string, uses?: (value: unknown) => boolean, entryKey?: boolean, clean?: (value: unknown, ctx: CleanContext) => unknown }} QueryShapeMark
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One identifier: a letter, then letters, digits or underscores, at most 40. */
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * The problems every mark of the two families can have: `since`, `shape`, `description`.
 * @param {Record<string, unknown>} mark
 * @param {string} where
 * @returns {string[]}
 */
function commonProblems(mark, where) {
    /** @type {string[]} */
    const out = [];
    try {
        requireSince(mark.since, where);
    } catch (e) {
        out.push(/** @type {Error} */ (e).message);
    }
    if (mark.valuesSince !== undefined) out.push(`${where}: "valuesSince" is not read here; a new form of the value is its own keys/queryShape/ file`);
    if (typeof mark.shape !== 'string' || !mark.shape.trim()) out.push(`${where}: "shape" gives the value's shape as catalogue text`);
    if (typeof mark.description !== 'string' || !mark.description.trim()) out.push(`${where}: "description" says in one sentence what it does`);
    return out;
}

/** The kinds `mark` names, or all four. @param {{ kinds?: unknown }} mark @returns {readonly string[]} */
function kindsOf(mark) {
    return Array.isArray(mark.kinds) ? mark.kinds.map(String) : QUERY_BINDING_KINDS;
}

/**
 * Why `mark` is not a usable mark for the binding key `key`, as sentences; empty when it is.
 * @param {string} key
 * @param {unknown} mark
 * @returns {string[]}
 */
function bindingMarkProblems(key, mark) {
    const where = `keys/binding/${key}.js`;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, one class with a bounded count (at most 40), no nesting: linear
    if (!NAME.test(key)) return [`${where}: the file is named after the key (letters, digits, underscores; at most 40)`];
    if (!isObject(mark)) return [`${where}: must export an object`];
    const out = commonProblems(mark, where);
    if (mark.kinds !== undefined && (!Array.isArray(mark.kinds) || !mark.kinds.length)) out.push(`${where}: "kinds" lists the binding kinds that take the key (${QUERY_BINDING_KINDS.join(', ')}), or is left out for all of them`);
    for (const kind of kindsOf(mark)) {
        if (!Object.hasOwn(BINDING_BASE_KEYS, kind)) out.push(`${where}: "${kind}" is not a binding kind a key can be marked on (${QUERY_BINDING_KINDS.join(', ')})`);
        else if (BINDING_BASE_KEYS[/** @type {keyof typeof BINDING_BASE_KEYS} */ (kind)].includes(key)) out.push(`${where}: "${key}" is a base key of ${kind} bindings; a new form of its value is a keys/queryShape/${key}.<name>.js file`);
    }
    if (typeof mark.clean !== 'function') out.push(`${where}: "clean" is the function the canonicalizer keeps the key with: (value) => the canonical value, or undefined to drop it`);
    if (mark.holds !== undefined && !QUERY_SHAPE_KEYS.includes(/** @type {string} */ (mark.holds))) out.push(`${where}: "holds" names the base key the value is read like (${QUERY_SHAPE_KEYS.join(', ')})`);
    return out;
}

/** What a predicate is tried with at load: none of these is a new form of anything. */
const NOT_A_SHAPE = Object.freeze([undefined, null, '', 'status == "open"', 0, true, Object.freeze([]), Object.freeze({}), Object.freeze([null, 1, 'x', Object.freeze([])])]);

/**
 * What is wrong with a predicate: it must answer false, without throwing, for values that are no form at all.
 * @param {(value: unknown) => unknown} uses
 * @param {string} where
 * @returns {string[]}
 */
function predicateProblems(uses, where) {
    for (const probe of NOT_A_SHAPE) {
        let answer;
        try {
            answer = uses(probe);
        } catch (e) {
            return [`${where}: "uses" threw for ${JSON.stringify(probe) ?? 'undefined'} (${/** @type {Error} */ (e).message}); it is total and answers false for what is not the form`];
        }
        if (answer !== false) return [`${where}: "uses" answered ${JSON.stringify(answer)} for ${JSON.stringify(probe) ?? 'undefined'}; it answers false for what is not the form`];
    }
    return [];
}

/**
 * Why `mark` is not a usable query-shape mark under the file name `name` (`<on>.<name>`).
 * @param {string} name
 * @param {unknown} mark
 * @returns {string[]}
 */
function queryShapeProblems(name, mark) {
    const where = `keys/queryShape/${name}.js`;
    const parts = name.split('.');
    if (parts.length !== 2 || !QUERY_SHAPE_KEYS.includes(parts[0]) || !NAME.test(parts[1])) {
        return [`${where}: the file is named <key>.<name>.js, <key> being the key the form sits under (${QUERY_SHAPE_KEYS.join(', ')})`];
    }
    if (!isObject(mark)) return [`${where}: must export an object`];
    const [on, shape] = parts;
    const out = commonProblems(mark, where);
    if (mark.entryKey === undefined) {
        if (typeof mark.uses !== 'function') out.push(`${where}: "uses" is the predicate (value) => boolean that says whether the value under "${on}" has the form (or "entryKey: true" with "clean" for a key of its entries)`);
        else out.push(...predicateProblems(/** @type {(value: unknown) => unknown} */ (mark.uses), where));
        if (mark.clean !== undefined) out.push(`${where}: "clean" goes with "entryKey: true"; a form with a predicate is kept by the code that reads "${on}"`);
        return out;
    }
    const base = Object.hasOwn(ENTRY_BASE_KEYS, on) ? ENTRY_BASE_KEYS[/** @type {keyof typeof ENTRY_BASE_KEYS} */ (on)] : null;
    if (mark.entryKey !== true || !base) out.push(`${where}: "entryKey: true" marks a key of the entries of ${Object.keys(ENTRY_BASE_KEYS).join(' or ')}; another form carries "uses"`);
    else if (base.includes(shape)) out.push(`${where}: "${shape}" is a base key of a ${on} entry`);
    if (mark.uses !== undefined) out.push(`${where}: an entry key has no "uses": an entry that carries the key uses it`);
    if (typeof mark.clean !== 'function') out.push(`${where}: "clean" is the function the canonicalizer keeps the entry key with: (value) => the canonical value, or undefined to drop it`);
    return out;
}

/**
 * The predicate of one query-shape mark: its own `uses`, or for an entry key "an entry of the list carries it".
 * @param {string} name  the file name, `<on>.<name>`
 * @param {QueryShapeMark} mark
 * @returns {(value: unknown) => boolean}
 */
function shapePredicate(name, mark) {
    if (typeof mark.uses === 'function') {
        const { uses } = mark;
        return (value) => uses(value) === true;
    }
    const key = name.slice(name.indexOf('.') + 1);
    return (value) => Array.isArray(value) && value.some((entry) => isObject(entry) && Object.hasOwn(entry, key) && entry[key] !== undefined && entry[key] !== null);
}

/**
 * The marks of the binding family as the schema-version index holds them: kind → key → since.
 * @param {Readonly<Record<string, { since?: unknown, kinds?: unknown }>> | undefined} bindingMarks
 * @returns {Record<string, Record<string, number>>}
 */
function bindingKeysSince(bindingMarks) {
    /** @type {Record<string, Record<string, number>>} */
    const out = Object.create(null);
    for (const [key, mark] of Object.entries(bindingMarks || {})) {
        if (!isObject(mark) || typeof mark.since !== 'number') continue;
        for (const kind of kindsOf(mark)) {
            if (!Object.hasOwn(out, kind)) out[kind] = Object.create(null);
            out[kind][key] = mark.since;
        }
    }
    return out;
}

/**
 * The query-shape marks as the schema-version walk reads them, per key of a definition object
 * that can hold the form: `since[key][name]` and the predicate `tests[key][name]`. A form of
 * `filter` is also read under the base keys that hold a clause list (SAME_VALUE_KEYS) and under
 * every marked binding key that says `holds: 'filter'`.
 * @param {Readonly<Record<string, QueryShapeMark>> | undefined} shapeMarks
 * @param {Readonly<Record<string, { holds?: unknown }>> | undefined} bindingMarks
 * @returns {{ since: Record<string, Record<string, number>>, tests: Record<string, Record<string, (value: unknown) => boolean>> }}
 */
function queryShapeIndex(shapeMarks, bindingMarks) {
    /** @type {Record<string, Record<string, number>>} */
    const since = Object.create(null);
    /** @type {Record<string, Record<string, (value: unknown) => boolean>>} */
    const tests = Object.create(null);
    for (const [name, mark] of Object.entries(shapeMarks || {})) {
        if (!isObject(mark) || typeof mark.since !== 'number') continue;
        const on = name.slice(0, name.indexOf('.'));
        const same = Object.hasOwn(SAME_VALUE_KEYS, on) ? SAME_VALUE_KEYS[/** @type {keyof typeof SAME_VALUE_KEYS} */ (on)] : [];
        const held = Object.entries(bindingMarks || {}).filter(([, binding]) => isObject(binding) && binding.holds === on).map(([key]) => key);
        const test = shapePredicate(name, mark);
        for (const key of [on, ...same, ...held]) {
            if (!Object.hasOwn(since, key)) { since[key] = Object.create(null); tests[key] = Object.create(null); }
            since[key][name] = mark.since;
            tests[key][name] = test;
        }
    }
    return { since, tests };
}

module.exports = {
    QUERY_BINDING_KINDS,
    BINDING_BASE_KEYS,
    QUERY_SHAPE_KEYS,
    ENTRY_BASE_KEYS,
    SAME_VALUE_KEYS,
    bindingMarkProblems,
    queryShapeProblems,
    shapePredicate,
    bindingKeysSince,
    queryShapeIndex,
    kindsOf,
};
