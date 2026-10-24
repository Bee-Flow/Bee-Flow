// @typecheck
/**
 * stores/studioApp/shared.js — the helpers every studio-app writer shares:
 * the managed-write guard, a transaction on the writers' db, and the
 * definition serializer with its byte ceiling.
 */

const { dep } = require('./deps');
const { LIMITS } = require('../../appStudio/componentSpecs');

/**
 * The managed-write guard (stores/lib/managedParts.js): an app filed into a
 * Solution stage project is changed in Dev and deployed. `io.managedParts` is
 * a test's own instance; the app uses the module's default, required lazily
 * because it reaches projectStore.
 */
function guardOf(io) {
    return io.managedParts || dep('managedPartsDefault')();
}

/** Run `fn` on one client of `io.db` in a transaction. */
async function inTx(io, fn) {
    return io.db.withTransaction(fn);
}

/**
 * Serialize a definition for storage, enforcing the byte ceiling from
 * componentSpecs. Throws with .code='definition_too_large' when exceeded so
 * routes can map it to a 413 instead of a generic 500.
 */
function serializeDefinition(definition) {
    const payload = JSON.stringify(definition ?? {});
    if (Buffer.byteLength(payload, 'utf8') > LIMITS.MAX_DEFINITION_BYTES) {
        const err = new Error(`App definition exceeds ${LIMITS.MAX_DEFINITION_BYTES} bytes`);
        err.code = 'definition_too_large';
        throw err;
    }
    return payload;
}

module.exports = { guardOf, inTx, serializeDefinition };
