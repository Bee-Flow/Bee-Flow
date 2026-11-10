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
 *
 * An entry without `since` belongs to the base. The walk itself is the pure
 * shared/appDefinition/schemaVersion.mjs; this module builds its index from the
 * live catalogue and binds it.
 */

import { createRequire } from 'node:module';
import {
    SCHEMA_VERSION_BASE,
    emptySinceIndex,
    requiredSchemaVersion as requiredWithIndex,
    isNewerSchemaVersion,
    envelopeVersionForRequired,
    supportedEnvelopeVersions,
} from '../shared/appDefinition/schemaVersion.mjs';
import { definitionKeys } from './definitionKeyRegistry.mts';
import type { DefinitionKeyEntry } from './definitionKeyRegistry.mts';

type SinceMap = Record<string, number>;
type SinceIndex = ReturnType<typeof emptySinceIndex>;
type Spec = { since?: unknown; valuesSince?: unknown; props?: Record<string, Spec> };
type SpecTable = Record<string, Spec>;

export interface Catalogue {
    componentSpecs?: SpecTable;
    styleKnobs?: SpecTable;
    stepSpecs?: SpecTable;
    actionSpecs?: SpecTable;
    bindingKindSince?: Record<string, unknown>;
    definitionKeys?: Pick<DefinitionKeyEntry, 'key' | 'since'>[];
}

const nodeRequire = createRequire(import.meta.url);
const specs = nodeRequire('./componentSpecs.js') as {
    SCHEMA_VERSION_CURRENT: number;
    COMPONENT_SPECS: SpecTable;
    STYLE_KNOBS: SpecTable;
    STEP_SPECS: SpecTable;
    ACTION_SPECS: SpecTable;
    BINDING_KIND_SINCE: Record<string, unknown>;
};
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

/** The since index of a catalogue: only what is marked above the base. */
export function buildSinceIndex(catalogue: Catalogue): SinceIndex {
    const index = emptySinceIndex();
    const unused: Record<string, SinceMap> = Object.create(null);
    for (const [type, spec] of Object.entries(catalogue.componentSpecs || {})) {
        if (!spec || typeof spec !== 'object') continue;
        if (above(spec.since)) index.componentTypes[type] = above(spec.since);
        const props: SinceMap = Object.create(null);
        const propValues: Record<string, SinceMap> = Object.create(null);
        readTable(spec.props, props, propValues);
        if (Object.keys(props).length) index.props[type] = props;
        if (Object.keys(propValues).length) index.propValues[type] = propValues;
    }
    readTable(catalogue.styleKnobs, index.styleKnobs, index.styleValues);
    readTable(catalogue.stepSpecs, index.stepKinds, unused);
    readTable(catalogue.actionSpecs, index.actionKinds, unused);
    for (const [kind, since] of Object.entries(catalogue.bindingKindSince || {})) {
        if (above(since)) index.bindingKinds[kind] = above(since);
    }
    for (const entry of catalogue.definitionKeys || []) {
        if (above(entry.since)) index.topLevelKeys[entry.key] = above(entry.since);
    }
    return index;
}

function liveCatalogue(): Catalogue {
    return {
        componentSpecs: specs.COMPONENT_SPECS,
        styleKnobs: specs.STYLE_KNOBS,
        stepSpecs: specs.STEP_SPECS,
        actionSpecs: specs.ACTION_SPECS,
        bindingKindSince: specs.BINDING_KIND_SINCE,
        definitionKeys: definitionKeys(),
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
    return requiredWithIndex(definition, currentIndex());
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
