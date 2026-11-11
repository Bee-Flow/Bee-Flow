// @typecheck strict
/**
 * App Studio — the lowest schema version a definition needs. Pure: imports only schemaVersionQuery.mjs.
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
 *     stepFields:        { [kind]: { [field]: n } },             a field added to an existing step kind
 *     stepFieldValues:   { [kind]: { [field]: { [value]: n } } }, an enum value added to a step field
 *     actionFields / actionFieldValues                          the same for an action kind
 *     stepItemKeys:      { [kind]: { [field]: { [key]: n } } },   a key on the items of a base step's list field (a case's `whenExpr`)
 *     itemShapes:     { [type]: { [prop]: ShapeMarks } },      keys and enum values added to the items of a list prop
 *     typeNodeKeys:   { [type]: { [key]: n } },                a node key an existing type newly takes (an event)
 *     keys:           { [family]: { [key]: n } },               a key added to one of the fixed objects below
 *     values:         { [family]: { [key]: { [value]: n } } },   an enum value added to one of their keys
 *     bindingKeys:    { [kind]: { [key]: n } },                 a key added to a binding of that kind
 *     queryShapes:    { [key]: { [name]: n } },                 a form of the value under a key (schemaVersionQuery.mjs)
 *   }
 *
 * ShapeMarks is `{ keys?, values?, items? }`: the marks of one item shape, `items` holding the
 * marks of a list nested in it. The families of `keys` / `values` are the objects a definition
 * is made of besides props and style (KEY_FAMILIES): a screen, a section, a section's style
 * (a knob newly allowed on sections), a node, the theme, the design, the nav, one nav group
 * and one declared variable.
 * The `query` family has values only: `op`, `fn` and `bucket` of a filter clause, an aggregate
 * and a group, wherever a binding or a step field holds one.
 *
 * Only entries above the base are listed; an empty index answers the base
 * without walking anything.
 */

import { queryShapeSince } from './schemaVersionQuery.mjs';

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
 *   stepFields: Record<string, SinceMap>,
 *   stepFieldValues: Record<string, Record<string, SinceMap>>,
 *   actionFields: Record<string, SinceMap>,
 *   actionFieldValues: Record<string, Record<string, SinceMap>>,
 *   stepItemKeys: Record<string, Record<string, SinceMap>>,
 *   itemShapes: Record<string, Record<string, ShapeMarks>>,
 *   typeNodeKeys: Record<string, SinceMap>,
 *   keys: Record<string, SinceMap>,
 *   values: Record<string, Record<string, SinceMap>>,
 *   bindingKeys: Record<string, SinceMap>, queryShapes: Record<string, SinceMap>,
 * }} SinceIndex
 * @typedef {{ keys?: SinceMap, values?: Record<string, SinceMap>, items?: Record<string, ShapeMarks> }} ShapeMarks
 * @typedef {import('./schemaVersionQuery.mjs').ShapeTests | undefined} Tests  the predicates of `queryShapes`
 */

/** The objects of a definition whose keys and scalar values the `keys` / `values` groups mark. */
export const KEY_FAMILIES = Object.freeze(['screen', 'section', 'sectionStyle', 'node', 'theme', 'design', 'nav', 'navGroup', 'variable']);
/** The family of the query vocabulary: values only (`op`, `fn`, `bucket`). */
export const QUERY_FAMILY = 'query';

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
        stepFields: map(),
        stepFieldValues: map(),
        actionFields: map(),
        actionFieldValues: map(),
        stepItemKeys: map(),
        itemShapes: map(),
        typeNodeKeys: map(),
        keys: map(),
        values: map(),
        bindingKeys: map(),
        queryShapes: map(),
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
 * The entry of `group` under `name`, own keys only.
 * @template T
 * @param {Record<string, T> | undefined} group
 * @param {unknown} name
 * @returns {T | undefined}
 */
function own(group, name) {
    return group && typeof name === 'string' && Object.prototype.hasOwnProperty.call(group, name) ? group[name] : undefined;
}

/**
 * The highest `since` of the keys and scalar values of `object`, as one of the fixed objects
 * of a definition (KEY_FAMILIES).
 * @param {unknown} object
 * @param {string} family
 * @param {SinceIndex} index
 */
function familySince(object, family, index) {
    return bagSince(object, own(index.keys, family), own(index.values, family));
}

/**
 * The highest `since` of the items of a list prop, against the marks of its item shape.
 * @param {unknown} list
 * @param {ShapeMarks | undefined} marks
 * @returns {number}
 */
function shapeSince(list, marks) {
    if (!marks || !Array.isArray(list)) return 0;
    let max = 0;
    for (const item of list) {
        if (!isObject(item)) continue;
        max = Math.max(max, bagSince(item, marks.keys, marks.values));
        for (const [key, nested] of Object.entries(marks.items || {})) max = Math.max(max, shapeSince(item[key], nested));
    }
    return max;
}

/** The highest `since` of the keys on the items of a list field of this step (`stepItemKeys`). @param {Record<string, unknown>} step @param {SinceIndex} index */
function stepItemsSince(step, index) {
    let max = 0;
    for (const [field, keys] of Object.entries(own(index.stepItemKeys, step.kind) || {})) {
        for (const item of listOf(step[field])) if (isObject(item)) max = Math.max(max, bagSince(item, keys, undefined));
    }
    return max;
}

/**
 * What one object inside a binding or a step field needs: a binding kind and the keys added to it, a step kind with
 * the fields added to it, the query vocabulary (`op`, `fn`, `bucket`) and the forms of the values it holds.
 * @param {Record<string, unknown>} value
 * @param {SinceIndex} index
 * @param {boolean} steps  also read the object as a step (inside an action)
 * @param {Tests} tests
 */
function objectSince(value, index, steps, tests) {
    const keys = bagSince(value, own(index.bindingKeys, value.kind), own(index.values, QUERY_FAMILY));
    let max = Math.max(sinceOf(index.bindingKinds, value.kind), keys, queryShapeSince(value, index.queryShapes, tests));
    if (steps) {
        max = Math.max(
            max,
            sinceOf(index.stepKinds, value.kind),
            bagSince(value, own(index.stepFields, value.kind), own(index.stepFieldValues, value.kind)),
            stepItemsSince(value, index),
        );
    }
    return max;
}

/**
 * The highest `since` anywhere under `value`. Every object is checked as a binding (and,
 * with `steps`, as a step), so a new place that holds one is covered without naming it here.
 * The payload of a static binding is the author's own data and is not read.
 * @param {unknown} value
 * @param {SinceIndex} index
 * @param {boolean} steps
 * @param {Tests} tests
 * @returns {number}
 */
function deepSince(value, index, steps, tests) {
    if (Array.isArray(value)) {
        let max = 0;
        for (const item of value) max = Math.max(max, deepSince(item, index, steps, tests));
        return max;
    }
    if (!isObject(value)) return 0;
    let max = objectSince(value, index, steps, tests);
    for (const [k, v] of Object.entries(value)) {
        if (k === 'value' && value.kind === 'static') continue;
        max = Math.max(max, deepSince(v, index, steps, tests));
    }
    return max;
}

/**
 * One action: its kind, the fields added to that kind, and everything under it as steps.
 * @param {unknown} action
 * @param {SinceIndex} index
 * @param {Tests} tests
 * @returns {number}
 */
function actionSince(action, index, tests) {
    if (!isObject(action)) return 0;
    return Math.max(
        sinceOf(index.actionKinds, action.kind),
        bagSince(action, own(index.actionFields, action.kind), own(index.actionFieldValues, action.kind)),
        deepSince(action, index, true, tests),
    );
}

/**
 * @param {unknown} node
 * @param {SinceIndex} index
 * @param {Tests} tests
 * @returns {number}
 */
function nodeSince(node, index, tests) {
    if (!isObject(node)) return 0;
    const type = typeof node.type === 'string' ? node.type : '';
    let max = Math.max(sinceOf(index.componentTypes, type), familySince(node, 'node', index), bagSince(node, own(index.typeNodeKeys, type), undefined));
    max = Math.max(max, bagSince(node.props, own(index.props, type), own(index.propValues, type)));
    max = Math.max(max, bagSince(node.style, index.styleKnobs, index.styleValues));
    const shapes = own(index.itemShapes, type);
    if (shapes && isObject(node.props)) {
        for (const [prop, marks] of Object.entries(shapes)) max = Math.max(max, shapeSince(node.props[prop], marks));
    }
    for (const [k, v] of Object.entries(node)) {
        if (k === 'children' || k === 'style' || k === 'type' || k === 'id') continue;
        max = Math.max(max, deepSince(v, index, false, tests));
    }
    for (const child of listOf(node.children)) max = Math.max(max, nodeSince(child, index, tests));
    return max;
}

/**
 * One screen: its own keys, its sections (keys, style) and their nodes.
 * @param {unknown} screen
 * @param {SinceIndex} index
 * @param {Tests} tests
 * @returns {number}
 */
function screenSince(screen, index, tests) {
    if (!isObject(screen)) return 0;
    let max = familySince(screen, 'screen', index);
    for (const section of listOf(screen.sections)) {
        if (!isObject(section)) continue;
        max = Math.max(
            max,
            familySince(section, 'section', index),
            bagSince(section.style, index.styleKnobs, index.styleValues),
            familySince(section.style, 'sectionStyle', index),
        );
        for (const node of listOf(section.children)) max = Math.max(max, nodeSince(node, index, tests));
    }
    return max;
}

/**
 * The look and the navigation: theme and design (also where a public page overrides them),
 * the nav and its groups.
 * @param {Record<string, unknown>} definition
 * @param {SinceIndex} index
 * @returns {number}
 */
function lookSince(definition, index) {
    const page = isObject(definition.publicAccess) ? definition.publicAccess : {};
    let max = Math.max(
        familySince(definition.theme, 'theme', index),
        familySince(definition.design, 'design', index),
        familySince(page.theme, 'theme', index),
        familySince(page.design, 'design', index),
        familySince(definition.nav, 'nav', index),
    );
    if (isObject(definition.nav)) {
        for (const group of listOf(definition.nav.groups)) max = Math.max(max, familySince(group, 'navGroup', index));
    }
    return max;
}

/**
 * The lowest schema version `definition` can be stored as: SCHEMA_VERSION_BASE
 * unless it uses something the index marks with a higher `since` (no query shape counts without `tests`).
 *
 * @param {unknown} definition
 * @param {SinceIndex} index
 * @param {Tests} [tests]
 * @returns {number}
 */
export function requiredSchemaVersion(definition, index, tests) {
    if (!isObject(definition) || !index || sinceIndexIsEmpty(index)) return SCHEMA_VERSION_BASE;
    let max = SCHEMA_VERSION_BASE;
    for (const key of Object.keys(definition)) max = Math.max(max, sinceOf(index.topLevelKeys, key));
    for (const screen of listOf(definition.screens)) max = Math.max(max, screenSince(screen, index, tests));
    if (isObject(definition.actions)) {
        for (const action of Object.values(definition.actions)) max = Math.max(max, actionSince(action, index, tests));
    }
    for (const variable of listOf(definition.variables)) max = Math.max(max, familySince(variable, 'variable', index));
    return Math.max(max, lookSince(definition, index));
}
