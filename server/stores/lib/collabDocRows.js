// @typecheck strict
'use strict';
/**
 * The vocabulary and row shapes of the co-editing store (../collabDocStore.js,
 * which documents the tables and re-exports these): the allowed values and
 * caps, the refusal error, the row mappers and the shared column list.
 */

const RESOURCE_KINDS = Object.freeze(['notebook', 'document']);
/**
 * The configStore key of each organisation's co-editing switch
 * (core/collab/settings.js reads and writes it). Declared here, beside the
 * co-editing tables, so the organisation teardown (a store) can name the key
 * without reaching up into core.
 */
const CONFIG_KEY_PREFIX = 'org_collab_';
const ORIGINS = Object.freeze(['user', 'ai', 'system', 'restore', 'import']);
const LIST_MAX = 500;
const LOAD_RETRIES = 3;
/** @type {readonly ('compactCount' | 'compactBytes' | 'sessionIdleMs' | 'materialiseIdleMs' | 'materialiseMaxLagMs' | 'sessionMaxMs')[]} */
const LIST_WORK_THRESHOLDS = Object.freeze(['compactCount', 'compactBytes', 'sessionIdleMs', 'materialiseIdleMs', 'materialiseMaxLagMs', 'sessionMaxMs']);

/** A refusal the caller turns into a worded 4xx. */
class CollabStoreError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = 'CollabStoreError';
        this.code = code;
    }
}

/** @param {string | number | Date | null} v */
const toIso = (v) => (v ? new Date(v).toISOString() : null);
/** @param {unknown} v */
const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));

/** PGlite answers BYTEA as a Uint8Array, node-postgres as a Buffer. Callers get a Buffer. */
/** @param {Uint8Array | Buffer | null | undefined} v */
function toBuffer(v) {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    return null;
}

/**
 * A document row. Blobs (`snapshot`, `checkpointSnapshot`) are included only
 * when the query selected them, still sealed.
 * @param {DbRow.CollabDocs | null | undefined} r
 */
function rowToDoc(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        resourceKind: r.resource_kind,
        resourceId: r.resource_id,
        field: r.field,
        ywire: r.ywire,
        keyScope: r.key_scope,
        updateSeq: toInt(r.update_seq),
        snapshotSeq: toInt(r.snapshot_seq),
        retainedFrom: toInt(r.retained_from),
        pendingCount: toInt(r.pending_count),
        pendingBytes: toInt(r.pending_bytes),
        stateBytes: toInt(r.state_bytes),
        materializedSeq: toInt(r.materialized_seq),
        materializedAt: toIso(r.materialized_at),
        checkpointSeq: toInt(r.checkpoint_seq),
        checkpointAt: toIso(r.checkpoint_at),
        sessionStartedAt: toIso(r.session_started_at),
        lastEditAt: toIso(r.last_edit_at),
        seededAt: toIso(r.seeded_at),
        createdBy: r.created_by || null,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
        ...(r.snapshot !== undefined ? { snapshot: toBuffer(r.snapshot) } : {}),
        ...(r.checkpoint_snapshot !== undefined ? { checkpointSnapshot: toBuffer(r.checkpoint_snapshot) } : {}),
    };
}

/** An update row, `body` still sealed. @param {DbRow.CollabDocUpdates} r */
function rowToUpdate(r) {
    return {
        seq: toInt(r.seq),
        body: toBuffer(r.body),
        byteLen: toInt(r.byte_len),
        userId: r.user_id || null,
        origin: r.origin,
        agentId: r.agent_id || null,
        createdAt: toIso(r.created_at),
    };
}

// Every column but the two blobs: most reads need the counters, not megabytes.
const DOC_COLUMNS = `id, project_id, resource_kind, resource_id, field, ywire, key_scope,
    update_seq, snapshot_seq, retained_from, pending_count, pending_bytes, state_bytes,
    materialized_seq, materialized_at, checkpoint_seq, checkpoint_at, session_started_at,
    last_edit_at, seeded_at, created_by, created_at, updated_at`;

/**
 * @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Q
 * @typedef {{ clientId: number, to: number }} ClientClock  `to` is the exclusive end clock of that client's structs
 */

module.exports = {
    RESOURCE_KINDS, CONFIG_KEY_PREFIX, ORIGINS, LIST_MAX, LOAD_RETRIES, LIST_WORK_THRESHOLDS,
    CollabStoreError, toIso, toInt, toBuffer, rowToDoc, rowToUpdate, DOC_COLUMNS,
};
