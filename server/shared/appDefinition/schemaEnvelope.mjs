// @typecheck strict
/**
 * App Studio — the schema version a stored definition carries, and the export envelope versions that
 * follow from it. Split from schemaVersion.mjs (the walk that works out the lowest version a definition
 * needs); pure, imports only its version constants.
 */

import { SCHEMA_VERSION_BASE, SCHEMA_VERSION_CURRENT } from './schemaVersion.mjs';

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v @returns {unknown[]} */
const listOf = (v) => (Array.isArray(v) ? v : []);

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
