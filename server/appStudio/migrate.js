// @typecheck strict
/**
 * App Studio — schema migrations.
 *
 * A chain of `{ from, to, run }` steps, one per schema version. migrateDefinition
 * walks a definition from the version it carries up to a target, one step at a
 * time; `run` reshapes, the chain stamps `to`.
 *
 * v1 → v2 is a pure SUPERSET: every v2 addition (new binding kinds, node logic
 * fields, role refs, action sequences, new component types) is optional, so a
 * valid v1 definition is already a valid v2 definition once its version tag is
 * bumped and the (optional) `roles` list is seeded. The migration is therefore
 * an IDENTITY plus two seeds — it never rewrites nodes, actions or bindings.
 *
 * v2 → v3 is an identity: everything version 3 adds is optional and marked
 * `since: 3` in the catalogue. The step exists so a later, non-additive change
 * has a place to go.
 *
 * migrateV1toV2(def) → a NEW definition (never mutates its input) with
 *   schemaVersion = 2 and roles = [] if absent. Lossless and idempotent:
 *   feeding a v2 def back through it is a no-op except for a shallow copy.
 *
 * canonicalize runs the chain inline as its first normalize step, so callers
 * that already canonicalize never need to migrate separately. The version a
 * definition is STORED with is not the chain's target: canonicalize writes the
 * lowest version the content needs (schemaSince.mts).
 */

'use strict';

const { SCHEMA_VERSION_BASE, SCHEMA_VERSION_CURRENT } = require('./componentSpecs');

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @typedef {{ from: number, to: number, run: (def: Record<string, unknown>) => Record<string, unknown> }} MigrationStep
 */

/**
 * One step per version, in order. `run` gets a shallow copy it may change and
 * must not touch nested objects of its input in place.
 * @type {readonly MigrationStep[]}
 */
const MIGRATIONS = Object.freeze([
    {
        from: 1,
        to: 2,
        run(def) {
            if (!('roles' in def)) def.roles = [];
            return def;
        },
    },
    { from: 2, to: 3, run: (def) => def },
]);

/**
 * The version a definition starts the chain at. Anything that is not a
 * version this chain has a step from (absent, a string, 0, 2.5) starts at 1:
 * the v1 → v2 seeds are idempotent, so that is lossless for a mislabelled v2.
 * @param {unknown} raw
 */
function startVersion(raw) {
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= SCHEMA_VERSION_CURRENT ? raw : 1;
}

/**
 * Walk `def` up the chain to `target` (default: the newest version). Returns a
 * NEW object stamped with the version it reached; never mutates its input.
 * Non-object input is returned unchanged, and so is a definition already above
 * `target`: this never downgrades and never throws on garbage.
 * @overload
 * @param {Record<string, unknown>} def
 * @param {number} [target]
 * @returns {Record<string, unknown>}
 */
/**
 * @overload
 * @param {unknown} def
 * @param {number} [target]
 * @returns {unknown}
 */
/** @param {unknown} def @param {number} [target] */
function migrateDefinition(def, target = SCHEMA_VERSION_CURRENT) {
    if (!isPlainObject(def)) return def;
    if (typeof def.schemaVersion === 'number' && def.schemaVersion > target) return def;
    let version = startVersion(def.schemaVersion);
    // Shallow copy preserves every nested reference by identity (lossless);
    // canonicalize deep-copies anything it decides to keep afterwards.
    /** @type {Record<string, unknown>} */
    let out = { ...def, schemaVersion: version };
    for (const step of MIGRATIONS) {
        if (step.from !== version || step.to > target) continue;
        out = step.run(out);
        out.schemaVersion = step.to;
        version = step.to;
    }
    return out;
}

/**
 * Upgrade a v1 (or already-v2) definition to version 2.
 * Non-object input is returned unchanged — canonicalize/validate own the
 * "not an object" error path, and this must never throw on garbage.
 * @overload
 * @param {Record<string, unknown>} def
 * @returns {Record<string, unknown>}
 */
/**
 * @overload
 * @param {unknown} def
 * @returns {unknown}
 */
/** @param {unknown} def */
function migrateV1toV2(def) {
    if (!isPlainObject(def)) return def;
    // Shallow copy preserves every nested reference by identity (lossless);
    // canonicalize deep-copies anything it decides to keep afterwards.
    /** @type {Record<string, unknown>} */
    const out = { ...def, schemaVersion: SCHEMA_VERSION_BASE };
    if (!('roles' in out)) out.roles = [];
    return out;
}

module.exports = { MIGRATIONS, migrateDefinition, migrateV1toV2 };
