// @typecheck
/**
 * Caps and timings of co-editing, in one place: the co-editing instance
 * (index.js) reads them, and so do the route schemas
 * (routes/projects/collabSchemas.js), whose string caps are derived from them
 * so the schema can never refuse what the service would accept.
 *
 * A module of its own, without dependencies, so a schema can require it
 * without loading the co-editing service.
 */

'use strict';

/** @param {string} name @param {number} fallback */
function envInt(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Caps and timings, overridable per instance (tests) and by environment. */
function defaultLimits() {
    return {
        maxUpdatesPerPost: 32,
        // One update must carry a page picture pasted as a data: URL (up to
        // 300 KB, about 410 KB as base64) plus its Yjs framing; the batch and
        // body caps below still bound a post.
        maxUpdateBytes: 576 * 1024,
        maxBatchBytes: 1024 * 1024,
        maxBodyBytes: 1536 * 1024,
        maxDocBytes: envInt('COLLAB_MAX_DOC_BYTES', 8 * 1024 * 1024),
        maxAwarenessStateBytes: 2048,
        maxStateVectorBytes: 64 * 1024,
        // Compaction job (jobs/collabDocCompaction.js).
        compactCount: 200,
        compactBytes: 512 * 1024,
        sessionIdleMs: 5 * 60_000,
        sessionMaxMs: 30 * 60_000,
        materialiseIdleMs: 30_000,
        materialiseMaxLagMs: 5 * 60_000,
        retentionGraceMs: 10 * 60_000,
        // A document the job could not finish (its owner refused the
        // content, a key was missing) waits this long before the next try,
        // unless somebody edits it first.
        failedWorkBackoffMs: 15 * 60_000,
        // How long a writer of the resource mirror waits for another one
        // writing the same document to finish.
        mirrorWaitMs: 5_000,
    };
}

/** Characters of base64 for `bytes` bytes (padded). @param {number} bytes */
const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;

module.exports = { defaultLimits, envInt, base64Length };
