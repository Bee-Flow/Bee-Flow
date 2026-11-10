/**
 * App Studio — the catalogue's `since` marks, and the schema-version questions
 * the server asks with them.
 *
 * Everything added to the catalogue after the frozen base carries a numeric
 * `since` on its own entry:
 *
 *   COMPONENT_SPECS[type].since                    a component type
 *   COMPONENT_SPECS[type].props[name].since        a prop added to an existing type
 *   COMPONENT_SPECS[type].props[name].valuesSince  { [value]: n }, an enum value added later
 *   STYLE_KNOBS[knob].since / .valuesSince         a style knob, an enum value added later
 *   STEP_SPECS[kind].since, ACTION_SPECS[kind].since
 *   BINDING_KIND_SINCE[kind]                       (BINDING_KINDS is a list of names)
 *   definitionKeys/<key>.js `since`                a top-level key
 *   STEP_SPECS[kind].fields[name].since / .valuesSince    a field added to an existing step kind
 *   ACTION_SPECS[kind].fields[name].since / .valuesSince  the same for an action kind
 *   …props[name].itemShape[key].since / .valuesSince      a key of the items of a list prop
 *                                                  (and of a list nested in those items)
 *   COMPONENT_SPECS[type].eventsSince              { [event]: n }, an event an existing type newly fires
 *   SCREEN_SPEC[key].since / .valuesSince          a screen key, an enum value of one
 *   THEME_SPEC[key] / DESIGN_SPEC[key] .since / .valuesSince   a theme or design key, a value
 *   componentSpecs/keys/<family>/<key>.js          a section, node, nav or nav-group key, a
 *                                                  knob newly allowed on sections (keyMarks.js)
 *   core/dataEngine/dataModel/vocabularySince.js   a filter operator, an aggregate function,
 *                                                  a date bucket (query vocabulary in a binding)
 *
 * One VALUE form has a version too: `asset:<id>`, an uploaded file of the app, accepted in
 * props and design keys that took only an https URL before (appAssets.mts ASSET_REF_SINCE).
 * So does a list of action ids in a component event slot (shared/appDefinition/
 * clientTriggers.mjs ACTION_LIST_SINCE): a slot held one id before schema 3.
 *
 * An entry without `since` belongs to the base. The walk itself is the pure
 * shared/appDefinition/schemaVersion.mjs; this module builds its index from the
 * live catalogue and binds it.
 */

import { createRequire } from 'node:module';
import {
    SCHEMA_VERSION_BASE,
    KEY_FAMILIES,
    QUERY_FAMILY,
    emptySinceIndex,
    requiredSchemaVersion as requiredWithIndex,
    isNewerSchemaVersion,
    envelopeVersionForRequired,
    supportedEnvelopeVersions,
} from '../shared/appDefinition/schemaVersion.mjs';
import { definitionKeys } from './definitionKeyRegistry.mts';
import { ASSET_REF_SINCE, hasAssetRef } from './appAssets.mts';
import { ACTION_LIST_SINCE, hasActionListSlot } from '../shared/appDefinition/clientTriggers.mjs';
import type { DefinitionKeyEntry } from './definitionKeyRegistry.mts';

type SinceMap = Record<string, number>;
type SinceIndex = ReturnType<typeof emptySinceIndex>;
type ShapeMarks = SinceIndex['itemShapes'][string][string];
type Spec = { since?: unknown; valuesSince?: unknown; eventsSince?: unknown; props?: Record<string, Spec>; fields?: Record<string, Spec>; itemShape?: Record<string, Spec> };
type SpecTable = Record<string, Spec>;
type KeyFamily = typeof KEY_FAMILIES[number];

export interface Catalogue {
    componentSpecs?: SpecTable;
    styleKnobs?: SpecTable;
    stepSpecs?: SpecTable;
    actionSpecs?: SpecTable;
    bindingKindSince?: Record<string, unknown>;
    definitionKeys?: Pick<DefinitionKeyEntry, 'key' | 'since'>[];
    /** Per family of schemaVersion.mjs KEY_FAMILIES: the table whose entries carry `since` / `valuesSince`. */
    keyTables?: Partial<Record<KeyFamily, SpecTable>>;
    /** The query vocabulary: `{ op: { <operator>: n }, fn: { <function>: n }, bucket: { <bucket>: n } }`. */
    queryValuesSince?: Record<string, unknown>;
}

const nodeRequire = createRequire(import.meta.url);
const specs = nodeRequire('./componentSpecs.js') as {
    SCHEMA_VERSION_CURRENT: number;
    COMPONENT_SPECS: SpecTable;
    STYLE_KNOBS: SpecTable;
    STEP_SPECS: SpecTable;
    ACTION_SPECS: SpecTable;
    BINDING_KIND_SINCE: Record<string, unknown>;
    SCREEN_SPEC: SpecTable;
    THEME_SPEC: SpecTable;
    DESIGN_SPEC: SpecTable;
    EVENT_NAMES: readonly string[];
    KEY_MARKS: Record<'section' | 'sectionStyle' | 'node' | 'nav' | 'navGroup', SpecTable>;
};
const { QUERY_VALUES_SINCE } = nodeRequire('../core/dataEngine/dataModel/vocabularySince.js') as { QUERY_VALUES_SINCE: Record<string, unknown> };
const { HttpError } = nodeRequire('../core/http/errors.js') as {
    HttpError: new (status: number, code: string, message: string) => Error;
};

/** The code a refusal carries, in canonicalize's `refused` and in a 422 body. */
export const SCHEMA_NEWER = 'schema_newer';

/** A `since` above the base, or 0. */
function above(since: unknown): number {
    return typeof since === 'number' && Number.isInteger(since) && since > SCHEMA_VERSION_BASE ? since : 0;
}

function valuesAbove(valuesSince: unknown): SinceMap | null {
    if (!valuesSince || typeof valuesSince !== 'object' || Array.isArray(valuesSince)) return null;
    const out: SinceMap = Object.create(null);
    for (const [value, since] of Object.entries(valuesSince)) {
        if (above(since)) out[value] = above(since);
    }
    return Object.keys(out).length ? out : null;
}

/** Fill `keys` and `values` from one spec table (types, knobs or props). */
function readTable(table: SpecTable | undefined, keys: SinceMap, values: Record<string, SinceMap>): void {
    for (const [name, spec] of Object.entries(table || {})) {
        if (!spec || typeof spec !== 'object') continue;
        if (above(spec.since)) keys[name] = above(spec.since);
        const perValue = valuesAbove(spec.valuesSince);
        if (perValue) values[name] = perValue;
    }
}

/**
 * Fill `intoKeys[owner]` and `intoValues[owner]` from one table, leaving `owner` out of a
 * group it has nothing in (an empty index answers the base without a walk).
 */
function readOwned(owner: string, table: SpecTable | undefined, intoKeys: Record<string, SinceMap>, intoValues: Record<string, Record<string, SinceMap>>): void {
    const keys: SinceMap = Object.create(null);
    const values: Record<string, SinceMap> = Object.create(null);
    readTable(table, keys, values);
    if (Object.keys(keys).length) intoKeys[owner] = keys;
    if (Object.keys(values).length) intoValues[owner] = values;
}

/** The marks of one item shape (and of the lists nested in it), or null when it has none. */
function shapeMarks(itemShape: Record<string, Spec> | undefined, depth = 0): ShapeMarks | null {
    if (!itemShape || typeof itemShape !== 'object' || depth > 4) return null;
    const keys: Record<string, SinceMap> = Object.create(null);
    const values: Record<string, Record<string, SinceMap>> = Object.create(null);
    readOwned('own', itemShape, keys, values);
    const items: Record<string, ShapeMarks> = Object.create(null);
    for (const [key, spec] of Object.entries(itemShape)) {
        const nested = spec && typeof spec === 'object' ? shapeMarks(spec.itemShape, depth + 1) : null;
        if (nested) items[key] = nested;
    }
    const marks: ShapeMarks = {};
    if (keys.own) marks.keys = keys.own;
    if (values.own) marks.values = values.own;
    if (Object.keys(items).length) marks.items = items;
    return Object.keys(marks).length ? marks : null;
}

function readComponents(table: SpecTable | undefined, index: SinceIndex): void {
    for (const [type, spec] of Object.entries(table || {})) {
        if (!spec || typeof spec !== 'object') continue;
        if (above(spec.since)) index.componentTypes[type] = above(spec.since);
        readOwned(type, spec.props, index.props, index.propValues);
        const shapes: Record<string, ShapeMarks> = Object.create(null);
        for (const [prop, propSpec] of Object.entries(spec.props || {})) {
            const marks = propSpec && typeof propSpec === 'object' ? shapeMarks(propSpec.itemShape) : null;
            if (marks) shapes[prop] = marks;
        }
        if (Object.keys(shapes).length) index.itemShapes[type] = shapes;
        const events = valuesAbove(spec.eventsSince);
        if (events) index.typeNodeKeys[type] = events;
    }
}

/** Step or action kinds: the kind itself, and the fields added to a kind. */
function readKinds(table: SpecTable | undefined, kinds: SinceMap, fields: Record<string, SinceMap>, fieldValues: Record<string, Record<string, SinceMap>>): void {
    readTable(table, kinds, Object.create(null));
    for (const [kind, spec] of Object.entries(table || {})) {
        if (spec && typeof spec === 'object') readOwned(kind, spec.fields, fields, fieldValues);
    }
}

/** The since index of a catalogue: only what is marked above the base. */
export function buildSinceIndex(catalogue: Catalogue): SinceIndex {
    const index = emptySinceIndex();
    readComponents(catalogue.componentSpecs, index);
    readTable(catalogue.styleKnobs, index.styleKnobs, index.styleValues);
    readKinds(catalogue.stepSpecs, index.stepKinds, index.stepFields, index.stepFieldValues);
    readKinds(catalogue.actionSpecs, index.actionKinds, index.actionFields, index.actionFieldValues);
    for (const [kind, since] of Object.entries(catalogue.bindingKindSince || {})) {
        if (above(since)) index.bindingKinds[kind] = above(since);
    }
    for (const entry of catalogue.definitionKeys || []) {
        if (above(entry.since)) index.topLevelKeys[entry.key] = above(entry.since);
    }
    for (const family of KEY_FAMILIES) readOwned(family, catalogue.keyTables?.[family], index.keys, index.values);
    const query: Record<string, SinceMap> = Object.create(null);
    for (const [key, marks] of Object.entries(catalogue.queryValuesSince || {})) {
        const perValue = valuesAbove(marks);
        if (perValue) query[key] = perValue;
    }
    if (Object.keys(query).length) index.values[QUERY_FAMILY] = query;
    return index;
}

/** The whole live catalogue, as buildSinceIndex reads it. Also what a test passes to _withCatalogue after changing a table in place. */
export function liveCatalogue(): Catalogue {
    return {
        componentSpecs: specs.COMPONENT_SPECS,
        styleKnobs: specs.STYLE_KNOBS,
        stepSpecs: specs.STEP_SPECS,
        actionSpecs: specs.ACTION_SPECS,
        bindingKindSince: specs.BINDING_KIND_SINCE,
        definitionKeys: definitionKeys(),
        keyTables: {
            screen: specs.SCREEN_SPEC,
            theme: specs.THEME_SPEC,
            design: specs.DESIGN_SPEC,
            section: specs.KEY_MARKS.section,
            sectionStyle: specs.KEY_MARKS.sectionStyle,
            node: specs.KEY_MARKS.node,
            nav: specs.KEY_MARKS.nav,
            navGroup: specs.KEY_MARKS.navGroup,
        },
        queryValuesSince: QUERY_VALUES_SINCE,
    };
}

// Built once: the catalogue and the key registry are fixed after load.
const liveIndex: SinceIndex = buildSinceIndex(liveCatalogue());
let overrideIndex: SinceIndex | null = null;

function currentIndex(): SinceIndex {
    return overrideIndex || liveIndex;
}

/** The lowest schema version `definition` can be stored as (2 unless it uses something marked since 3 or higher). */
export function requiredSchemaVersion(definition: unknown): number {
    let required = requiredWithIndex(definition, currentIndex());
    if (required < ACTION_LIST_SINCE && hasActionListSlot(definition, specs.EVENT_NAMES)) required = ACTION_LIST_SINCE;
    return required >= ASSET_REF_SINCE || !hasAssetRef(definition) ? required : ASSET_REF_SINCE;
}

/** True when `definition` was written by an install that knows a newer schema than this one. */
export function isSchemaNewer(definition: unknown): boolean {
    return isNewerSchemaVersion(definition, specs.SCHEMA_VERSION_CURRENT);
}

export function schemaNewerMessage(definition: unknown): string {
    const got = (definition as { schemaVersion?: unknown } | null)?.schemaVersion;
    return `This app was made with a newer version of Bee Flow (definition version ${JSON.stringify(got)}; this installation reads up to ${specs.SCHEMA_VERSION_CURRENT}). Update Bee Flow to change it.`;
}

/** The 422 a save, publish or import answers for a definition this install must not rewrite. */
export function schemaNewerError(definition: unknown): Error {
    return new HttpError(422, SCHEMA_NEWER, schemaNewerMessage(definition));
}

/** The body of that 422, for a route that answers by hand. */
export function schemaNewerBody(definition: unknown): { error: string; code: string } {
    return { error: schemaNewerMessage(definition), code: SCHEMA_NEWER };
}

/**
 * The version an export envelope is written with, from what the definitions in
 * it need (shared/appDefinition/schemaVersion.mjs says how the number moves).
 */
export function envelopeVersionFor(baseVersion: number, definitions: unknown[]): number {
    let required = SCHEMA_VERSION_BASE;
    for (const def of definitions) required = Math.max(required, requiredSchemaVersion(def));
    return envelopeVersionForRequired(baseVersion, required);
}

export { supportedEnvelopeVersions };

/** Test-only: run `fn` against `catalogue` instead of the live one. */
export function _withCatalogue<T>(catalogue: Catalogue, fn: () => T): T {
    const before = overrideIndex;
    overrideIndex = buildSinceIndex(catalogue);
    try {
        return fn();
    } finally {
        overrideIndex = before;
    }
}
