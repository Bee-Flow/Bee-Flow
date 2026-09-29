/**
 * App Studio — schema migrations.
 *
 * v1 → v2 is a pure SUPERSET: every v2 addition (new binding kinds, node logic
 * fields, role refs, action sequences, new component types) is optional, so a
 * valid v1 definition is already a valid v2 definition once its version tag is
 * bumped and the (optional) `roles` list is seeded. The migration is therefore
 * an IDENTITY plus two seeds — it never rewrites nodes, actions or bindings.
 *
 * migrateV1toV2(def) → a NEW definition (never mutates its input) with
 *   schemaVersion = 2 and roles = [] if absent. Lossless and idempotent:
 *   feeding a v2 def back through it is a no-op except for a shallow copy.
 *
 * canonicalize.js runs this inline as its first normalize step, so callers that
 * already canonicalize never need to migrate separately; the standalone export
 * exists for the store / route so a v1 row can be upgraded in place on read.
 */

'use strict';

const { SCHEMA_VERSION_CURRENT } = require('./componentSpecs');

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Upgrade a v1 (or already-v2) definition to the current schema version.
 * Non-object input is returned unchanged — canonicalize/validate own the
 * "not an object" error path, and this must never throw on garbage.
 */
function migrateV1toV2(def) {
    if (!isPlainObject(def)) return def;
    // Shallow copy preserves every nested reference by identity (lossless);
    // canonicalize deep-copies anything it decides to keep afterwards.
    const out = { ...def, schemaVersion: SCHEMA_VERSION_CURRENT };
    if (!('roles' in out)) out.roles = [];
    return out;
}

module.exports = { migrateV1toV2 };
