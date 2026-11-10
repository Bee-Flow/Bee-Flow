// @typecheck strict
/**
 * App Studio — the lowest schema version a definition needs. Pure, imports nothing.
 *
 * Every catalogue entry added after the frozen base carries a numeric `since`
 * (3 or higher). A definition that uses none of them needs SCHEMA_VERSION_BASE,
 * so its canonical bytes never move when the catalogue grows.
 *
 * The catalogue itself lives on the server (appStudio/componentSpecs), so the
 * walk reads a plain "since index" the caller builds from it
 * (appStudio/schemaSince.mts does that for the server and binds it):
 *
 *   {
 *     componentTypes: { [type]: n },
 *     props:          { [type]: { [prop]: n } },             a prop added to an existing type
 *     propValues:     { [type]: { [prop]: { [value]: n } } }, an enum value added to a prop
 *     styleKnobs:     { [knob]: n },                          node and section style share the table
 *     styleValues:    { [knob]: { [value]: n } },             an enum value added to a knob
 *     stepKinds:      { [kind]: n },
 *     actionKinds:    { [kind]: n },
 *     bindingKinds:   { [kind]: n },
 *     topLevelKeys:   { [key]: n },
 *   }
 *
 * Only entries above the base are listed; an empty index answers the base
 * without walking anything.
 */

/** The version every definition written before `since` existed has. */
export const SCHEMA_VERSION_BASE = 2;
/** The newest version this build reads. A definition above it is refused, never normalised. */
export const SCHEMA_VERSION_CURRENT = 3;

/**
 * @typedef {Record<string, number>} SinceMap
 * @typedef {{
 *   componentTypes: SinceMap,
 *   props: Record<string, SinceMap>,
 *   propValues: Record<string, Record<string, SinceMap>>,
 *   styleKnobs: SinceMap,
 *   styleValues: Record<string, SinceMap>,
 *   stepKinds: SinceMap,
 *   actionKinds: SinceMap,
 *   bindingKinds: SinceMap,
 *   topLevelKeys: SinceMap,
 * }} SinceIndex
 */

/** @returns {SinceIndex} */
export function emptySinceIndex() {
    const map = () => Object.create(null);
    return {
        componentTypes: map(),
        props: map(),
        propValues: map(),
        styleKnobs: map(),
        styleValues: map(),
        stepKinds: map(),
        actionKinds: map(),
        bindingKinds: map(),
        topLevelKeys: map(),
    };
}

/** @param {SinceIndex} index */
export function sinceIndexIsEmpty(index) {
    return Object.values(index).every((group) => Object.keys(group).length === 0);
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v @returns {unknown[]} */
const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * `since` of `name` in `map`, or 0. Own keys only: "constructor" is not an entry.
 * @param {SinceMap | undefined} map
 * @param {unknown} name
 */
function sinceOf(map, name) {
    if (!map || typeof name !== 'string') return 0;
    return Object.prototype.hasOwnProperty.call(map, name) ? Number(map[name]) || 0 : 0;
}

/**
 * The highest `since` among the keys of `bag` and, per key, its scalar value.
 * @param {unknown} bag
 * @param {SinceMap | undefined} keys
 * @param {Record<string, SinceMap> | undefined} values
 */
function bagSince(bag, keys, values) {
    if (!isObject(bag)) return 0;
    let max = 0;
    for (const [k, v] of Object.entries(bag)) {
        max = Math.max(max, sinceOf(keys, k));
        const perValue = values && Object.prototype.hasOwnProperty.call(values, k) ? values[k] : undefined;
        if (perValue && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
            max = Math.max(max, sinceOf(perValue, String(v)));
        }
    }
    return max;
}

/**
 * The highest binding-kind `since` anywhere under `value`. The payload of a
 * static binding is the author's own data and is not read.
 * @param {unknown} value
 * @param {SinceMap} kinds
 * @returns {number}
 */
function bindingSince(value, kinds) {
    if (Array.isArray(value)) {
        let max = 0;
        for (const item of value) max = Math.max(max, bindingSince(item, kinds));
        return max;
    }
    if (!isObject(value)) return 0;
    let max = sinceOf(kinds, value.kind);
    for (const [k, v] of Object.entries(value)) {
        if (k === 'value' && value.kind === 'static') continue;
        max = Math.max(max, bindingSince(v, kinds));
    }
    return max;
}

/**
 * @param {unknown} step
 * @param {SinceIndex} index
 * @returns {number}
 */
function stepSince(step, index) {
    if (!isObject(step)) return 0;
    let max = sinceOf(index.stepKinds, step.kind);
    for (const [k, v] of Object.entries(step)) {
        if (k === 'kind') continue;
        max = Math.max(max, fieldSince(v, index));
    }
    return max;
}

/**
 * A step field: a list of child steps, a handler, a case list or a binding.
 * Every object with a string `kind` is checked as a step and as a binding, so
 * a new place that holds steps is covered without naming it here.
 * @param {unknown} value
 * @param {SinceIndex} index
 * @returns {number}
 */
function fieldSince(value, index) {
    if (Array.isArray(value)) {
        let max = 0;
        for (const item of value) max = Math.max(max, fieldSince(item, index));
        return max;
    }
    if (!isObject(value)) return 0;
    let max = Math.max(sinceOf(index.stepKinds, value.kind), sinceOf(index.bindingKinds, value.kind));
    for (const [k, v] of Object.entries(value)) {
        if (k === 'value' && value.kind === 'static') continue;
        max = Math.max(max, fieldSince(v, index));
    }
    return max;
}

/**
 * @param {unknown} node
 * @param {SinceIndex} index
 * @returns {number}
 */
function nodeSince(node, index) {
    if (!isObject(node)) return 0;
    const type = typeof node.type === 'string' ? node.type : '';
    const own = (/** @type {Record<string, unknown>} */ group) => (
        type && Object.prototype.hasOwnProperty.call(group, type) ? group[type] : undefined
    );
    let max = sinceOf(index.componentTypes, type);
    max = Math.max(max, bagSince(
        node.props,
        /** @type {SinceMap | undefined} */ (own(index.props)),
        /** @type {Record<string, SinceMap> | undefined} */ (own(index.propValues)),
    ));
    max = Math.max(max, bagSince(node.style, index.styleKnobs, index.styleValues));
    for (const [k, v] of Object.entries(node)) {
        if (k === 'children' || k === 'style' || k === 'type' || k === 'id') continue;
        max = Math.max(max, bindingSince(v, index.bindingKinds));
    }
    for (const child of listOf(node.children)) max = Math.max(max, nodeSince(child, index));
    return max;
}

/**
 * The lowest schema version `definition` can be stored as: SCHEMA_VERSION_BASE
 * unless it uses something the index marks with a higher `since`.
 *
 * @param {unknown} definition
 * @param {SinceIndex} index
 * @returns {number}
 */
export function requiredSchemaVersion(definition, index) {
    if (!isObject(definition) || !index || sinceIndexIsEmpty(index)) return SCHEMA_VERSION_BASE;
    let max = SCHEMA_VERSION_BASE;
    for (const key of Object.keys(definition)) max = Math.max(max, sinceOf(index.topLevelKeys, key));
    for (const screen of listOf(definition.screens)) {
        if (!isObject(screen)) continue;
        for (const section of listOf(screen.sections)) {
            if (!isObject(section)) continue;
            max = Math.max(max, bagSince(section.style, index.styleKnobs, index.styleValues));
            for (const node of listOf(section.children)) max = Math.max(max, nodeSince(node, index));
        }
    }
    if (isObject(definition.actions)) {
        for (const action of Object.values(definition.actions)) {
            if (!isObject(action)) continue;
            max = Math.max(max, sinceOf(index.actionKinds, action.kind), stepSince(action, index));
        }
    }
    return max;
}

/**
 * True when `definition` carries a schema version above `current`: written by
 * a newer install, so this one must not normalise it.
 *
 * @param {unknown} definition
 * @param {number} current
 */
export function isNewerSchemaVersion(definition, current) {
    if (!isObject(definition)) return false;
    const v = definition.schemaVersion;
    return typeof v === 'number' && Number.isFinite(v) && v > current;
}

/**
 * The version an export envelope is written with when the definitions in it
 * need schema version `required`. `baseVersion` is the format's version for
 * the base schema; each schema version above the base raises it by one, so an
 * install that does not know that schema refuses the file at its envelope
 * check instead of dropping what it cannot read.
 *
 * @param {number} baseVersion
 * @param {number} required
 */
export function envelopeVersionForRequired(baseVersion, required) {
    return baseVersion + Math.max(0, required - SCHEMA_VERSION_BASE);
}

/**
 * The same, read from the `schemaVersion` each STORED definition carries: a
 * stored definition is canonical, and canonicalize writes the lowest version
 * its content needs. For a writer that cannot reach the catalogue.
 *
 * @param {number} baseVersion
 * @param {unknown} definitions
 */
export function envelopeVersionForStored(baseVersion, definitions) {
    let required = SCHEMA_VERSION_BASE;
    for (const def of listOf(definitions)) {
        const v = isObject(def) ? def.schemaVersion : undefined;
        if (typeof v === 'number' && Number.isInteger(v) && v > required) required = v;
    }
    return envelopeVersionForRequired(baseVersion, required);
}

/**
 * The envelope versions this build reads: `baseSupported` plus one per schema
 * version it knows above the base.
 *
 * @param {readonly number[]} baseSupported
 * @param {number} baseVersion
 * @returns {number[]}
 */
export function supportedEnvelopeVersions(baseSupported, baseVersion) {
    const out = [...baseSupported];
    for (let v = SCHEMA_VERSION_BASE + 1; v <= SCHEMA_VERSION_CURRENT; v++) {
        out.push(envelopeVersionForRequired(baseVersion, v));
    }
    return out;
}
