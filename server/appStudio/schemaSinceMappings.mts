/**
 * App Studio — the schema version an input mapping needs.
 *
 * A run_automation action or step maps each automation input to a value: `{ kind: 'static' | 'field' }`
 * in the base, and the kinds of componentSpecs/actionSpecsServer.js INPUT_MAPPING_KIND_SINCE after it
 * (`formula`, since 3). A mapping is a map of entries, not an enum field, so the catalogue walk of
 * shared/appDefinition/schemaVersion.mjs does not see the kind of an entry: this reads it.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { INPUT_MAPPING_KIND_SINCE } = nodeRequire('./componentSpecs/actionSpecsServer.js') as { INPUT_MAPPING_KIND_SINCE: Readonly<Record<string, number>> };

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deeper than any action the validator accepts. */
const MAX_DEPTH = 32;

function entriesSince(mapping: unknown): number {
    if (!isObject(mapping)) return 0;
    let max = 0;
    for (const entry of Object.values(mapping)) {
        const kind = isObject(entry) ? entry.kind : undefined;
        if (typeof kind === 'string' && Object.hasOwn(INPUT_MAPPING_KIND_SINCE, kind)) max = Math.max(max, INPUT_MAPPING_KIND_SINCE[kind]);
    }
    return max;
}

function walk(value: unknown, depth: number): number {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return 0;
    if (Array.isArray(value)) return value.reduce<number>((max, item) => Math.max(max, walk(item, depth + 1)), 0);
    const object = value as Obj;
    let max = entriesSince(object.inputMapping);
    for (const [key, inner] of Object.entries(object)) {
        // The payload of a static value is the author's own data, and a mapping's entries were read above.
        if (key === 'inputMapping' || (key === 'value' && object.kind === 'static')) continue;
        max = Math.max(max, walk(inner, depth + 1));
    }
    return max;
}

/** The highest `since` of the input-mapping kinds used anywhere in the actions of `definition` (0 for none). */
export function mappingKindSince(definition: unknown): number {
    return isObject(definition) ? walk(definition.actions, 0) : 0;
}
