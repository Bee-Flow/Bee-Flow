// @typecheck
/**
 * Blueprint store helpers without a database: id minting, the row mappers
 * (each an explicit allow-list), the input normalisers and size checks, the
 * read rule (`canRead`), and the query handle over a transaction client.
 */

'use strict';

const crypto = require('crypto');
const {
    MAX_BLUEPRINT_BYTES,
    MAX_NOTES_BYTES,
    MAX_RELEASE_PAYLOAD_BYTES,
    RELEASE_PAYLOAD_KINDS,
    BUILTIN_REF_PREFIX,
    REF_PREFIX_RE,
} = require('./constants');

function newId() { return `bp_${crypto.randomBytes(8).toString('hex')}`; }
function newReleaseId() { return `rel_${crypto.randomBytes(8).toString('hex')}`; }

/**
 * @param {string | undefined} v
 */
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * An error a route may pass on: status, code, and a message written for people.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function storeError(status, code, message) {
    return Object.assign(new Error(message), { status, code, expose: true });
}

/**
 * The context the factory modules (gallery, releases, installs) are built
 * over: the db facade, the schema-init gate, and the two handle helpers
 * `makeBlueprintStore` defines.
 * @typedef {{ one: (sql: string, params?: any[]) => Promise<any>, all: (sql: string, params?: any[]) => Promise<any[]>, run: (sql: string, params?: any[]) => Promise<{ rowCount: number }> }} QueryHandle
 * @typedef {{
 *   db: {
 *     run: (sql: string, params?: any[]) => Promise<any>,
 *     getOne: (sql: string, params?: any[]) => Promise<any>,
 *     getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *     withTransaction: (fn: (client: any) => Promise<any>) => Promise<any>,
 *   },
 *   ready: () => Promise<unknown>,
 *   handle: (client?: any) => QueryHandle,
 *   inTransaction: <T>(client: any, fn: (h: QueryHandle) => Promise<T>) => Promise<T>,
 * }} BlueprintStoreCtx
 */

/**
 * One query handle over the client of a running transaction.
 *
 * Exists so `saveBlueprint` and `publishRelease` run LITERALLY the same
 * statements. A second copy of the bump logic that "also just" fits in a
 * transaction is a second copy that drifts out of step — and that is exactly
 * where it must not, because then the version number the gallery serves
 * differs from the version number the history records. The pool handle is
 * built by the factory (`handle` in `makeBlueprintStore`).
 * @param {{ query: (sql: string, params?: any[]) => Promise<any> }} client
 */
function clientHandle(client) {
    return {
        one: async (sql, params) => (await client.query(sql, params)).rows?.[0] || null,
        all: async (sql, params) => (await client.query(sql, params)).rows || [],
        run: async (sql, params) => {
            const r = await client.query(sql, params);
            return { rowCount: r?.rowCount ?? 0 };
        },
    };
}

/** True for an id this store owns. */
function isBlueprintId(id) { return typeof id === 'string' && id.startsWith('bp_'); }

/** @param {DbRow.ProjectBlueprints | null} row */
function mapRow(row, { includeManifest = true } = {}) {
    if (!row) return null;
    const meta = {
        id: row.id,
        solutionKey: row.solution_key,
        version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
        name: row.name,
        description: row.description || '',
        icon: row.icon || null,
        createdBy: row.created_by,
        sourceProjectId: row.source_project_id || null,
        organizationId: row.organization_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (!includeManifest) return meta;
    return { ...meta, manifest: row.manifest || null };
}

/**
 * Which entity is the fat one.
 *
 * Reported rather than guessed at: the point of a size refusal is that someone
 * can act on it, and "deselect a table on the orders app" is an action where
 * "make it smaller" is not.
 */
function largestEntity(manifest) {
    const entities = manifest?.solution?.entities || {};
    let worst = null;
    for (const [kind, list] of Object.entries(entities)) {
        for (const entity of (Array.isArray(list) ? list : [])) {
            const bytes = Buffer.byteLength(JSON.stringify(entity), 'utf8');
            if (!worst || bytes > worst.bytes) {
                worst = { kind, bytes, name: entity.name || entity.title || entity.ref };
            }
        }
    }
    return worst;
}

/** Refuse a manifest over the ceiling, naming its largest part. */
function assertManifestSize(manifest) {
    const bytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
    if (bytes <= MAX_BLUEPRINT_BYTES) return;
    const worst = largestEntity(manifest);
    /**
     * @param {number} n
     */
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    throw new Error(
        worst
            ? `This Blueprint is ${mb(bytes)}, over the ${mb(MAX_BLUEPRINT_BYTES)} limit. The largest part is the ${worst.kind.replace(/s$/, '')} "${worst.name}" at ${mb(worst.bytes)}.`
            : `This Blueprint is ${mb(bytes)}, over the ${mb(MAX_BLUEPRINT_BYTES)} limit.`,
    );
}

/** A note is a note: a plain object, and bounded. */
function normalizeNotes(notes) {
    if (notes == null) return {};
    if (typeof notes !== 'object' || Array.isArray(notes)) {
        throw new Error('Release notes must be an object.');
    }
    /** @type {string} */
    let json;
    try { json = JSON.stringify(notes); } catch (_) { json = undefined; }
    if (typeof json !== 'string') throw new Error('Release notes must be plain JSON.');
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_NOTES_BYTES) {
        /**
         * @param {number} n
         */
        const kb = (n) => `${Math.round(n / 1024)} KB`;
        throw new Error(`These release notes are ${kb(bytes)}, over the ${kb(MAX_NOTES_BYTES)} limit. Shorten the note — the Blueprint itself is stored separately.`);
    }
    return notes;
}

/**
 * What a release row IS to the outside.
 *
 * Built from an EXPLICIT ALLOW-LIST, not by deleting keys from the row: a
 * column added to `project_releases` next year then does not travel along by
 * itself. The manifest stays HOME by default — a list of twenty releases would
 * otherwise be twenty manifests.
 *
 * `withPipeline` adds the stage fields (seq, channel, gate, contentHash), again
 * by name. `source_cut` (the version tokens read at capture) stays home.
 */
function mapReleaseRow(row, { includeManifest = false, withPipeline = false } = {}) {
    if (!row) return null;
    /** @type {Record<string, any>} */
    const meta = {
        id: row.id,
        projectId: row.project_id,
        blueprintId: row.blueprint_id,
        version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
        notes: isPlainObject(row.notes) ? row.notes : {},
        publishedAt: row.published_at,
        publishedBy: row.published_by,
    };
    if (withPipeline) {
        meta.seq = Number.isInteger(row.seq) && row.seq > 0 ? row.seq : null;
        meta.channel = row.channel === 'pipeline' ? 'pipeline' : 'gallery';
        meta.gate = isPlainObject(row.gate) ? row.gate : null;
        meta.contentHash = isNonEmptyString(row.content_hash) ? row.content_hash : null;
    }
    if (!includeManifest) return meta;
    return { ...meta, manifest: row.manifest || null };
}

// The columns `mapReleaseRow(…, { withPipeline: true })` reads, minus the manifest.
const PIPELINE_RELEASE_COLUMNS = `id, project_id, blueprint_id, version, notes, published_at, published_by,
                                  seq, channel, gate, content_hash`;

const STAMP_COLUMNS = `project_id, ref, kind, entity_id, install_hash, installed_version,
                       release_id, source_hash, step_id_map, retired_at, updated_at`;

/** One stamp, by name. The shape `listStamps` has always returned, plus the stage columns. */
function mapStampRow(r) {
    if (!r) return null;
    return {
        ref: r.ref,
        kind: r.kind,
        entityId: r.entity_id,
        installHash: r.install_hash,
        installedVersion: r.installed_version,
        releaseId: r.release_id ?? null,
        sourceHash: r.source_hash ?? null,
        stepIdMap: isPlainObject(r.step_id_map) ? r.step_id_map : null,
        retiredAt: r.retired_at ?? null,
        updatedAt: r.updated_at ?? null,
    };
}

/**
 * A count value, or null when there is none. Never a silent 0.
 * @param {string} raw
 */
function asCount(raw) {
    const n = typeof raw === 'number' ? raw
        : (typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The columns of a gallery row MINUS the manifest.
 *
 * Exists so a reader that needs only the meta (the access question, a counter)
 * does not drag several megabytes of JSONB through the pool only to throw it
 * away. `mapRow(..., { includeManifest: false })` already yields the same
 * shape; this is the same decision one layer down.
 */
const META_COLUMNS = `id, organization_id, created_by, source_project_id, solution_key,
                      name, description, icon, version, created_at, updated_at`;

/**
 * Org members may install; only the creator may delete.
 *
 * ONE RULE, AND IT IS `listBlueprintsFor`'s. That query answers: an org
 * blueprint belongs to the organisation, a personal one (org NULL) to whoever
 * captured it. This predicate used to answer something wider — it returned true
 * for `createdBy === userId` BEFORE looking at the organisation at all — and the
 * gap between the two was reachable: someone who captured a Blueprint for org A
 * and has since moved to org B could no longer see it in any list, but could
 * still read and install it by id. A permission that the list and the fetch
 * disagree about is decided by whichever one the caller happens to use.
 *
 * So the creator clause now lives where the list puts it: on personal
 * Blueprints only. A creator still inside the owning org keeps access through
 * the org clause, which is the same access every colleague has.
 * @param blueprint
 * @param {{ userId?: string, organizationId?: string|null }} [opts]
 */
function canRead(blueprint, { userId, organizationId = null } = {}) {
    if (!blueprint) return false;
    return blueprint.organizationId
        ? blueprint.organizationId === organizationId
        : blueprint.createdBy === userId;
}

/**
 * The ledger's input, checked and de-duplicated: [{kind, entityId, prefix}] in
 * the caller's order (the order in which new refs are numbered).
 * @param {any[]} members
 * @param {(kind: string) => string|undefined} prefixOf
 */
function normalizeMembers(members, prefixOf) {
    const out = [];
    const seen = new Set();
    for (const m of members) {
        const kind = m?.kind;
        const entityId = m?.entityId;
        if (!isNonEmptyString(kind) || !isNonEmptyString(entityId)) {
            throw new TypeError('allocateRefs: every member needs a kind and an entityId');
        }
        const prefix = prefixOf(kind) || BUILTIN_REF_PREFIX[kind];
        if (!isNonEmptyString(prefix) || !REF_PREFIX_RE.test(prefix)) {
            throw new TypeError(`allocateRefs: no ref prefix for kind '${kind}'`);
        }
        const key = JSON.stringify([kind, entityId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind, entityId, prefix });
    }
    return out;
}

/**
 * The payloads of a pipeline release, checked. Each is
 * {ref, kind, sourceEntityId, payload, contentHash}; at most one per (ref, kind).
 * @param {unknown} payloads
 */
function normalizePayloads(payloads) {
    if (payloads == null) return [];
    if (!Array.isArray(payloads)) throw new TypeError('payloads must be an array');
    const seen = new Set();
    let bytes = 0;
    const out = payloads.map((p) => {
        if (!isNonEmptyString(p?.ref) || !RELEASE_PAYLOAD_KINDS.includes(p?.kind)
            || !isNonEmptyString(p?.sourceEntityId) || !isNonEmptyString(p?.contentHash)
            || !isPlainObject(p?.payload)) {
            throw new TypeError('A release payload needs ref, a known kind, sourceEntityId, an object payload and contentHash');
        }
        const key = `${p.kind}:${p.ref}`;
        if (seen.has(key)) throw new TypeError(`Two release payloads for ${key}`);
        seen.add(key);
        const json = JSON.stringify(p.payload);
        bytes += Buffer.byteLength(json, 'utf8');
        return { ref: p.ref, kind: p.kind, sourceEntityId: p.sourceEntityId, contentHash: p.contentHash, json };
    });
    if (bytes > MAX_RELEASE_PAYLOAD_BYTES) {
        throw storeError(413, 'release_payload_too_large',
            `The data carried with this release is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_RELEASE_PAYLOAD_BYTES / 1024 / 1024} MB limit.`);
    }
    return out;
}

/**
 * Whether the payloads stored with a release (`ref, kind, content_hash` rows)
 * are exactly the normalised incoming ones, by (ref, kind, contentHash).
 * @param {Array<{ ref: string, kind: string, content_hash: string }>} stored
 * @param {Array<{ ref: string, kind: string, contentHash: string }>} incoming
 */
function samePayloadSet(stored, incoming) {
    if (stored.length !== incoming.length) return false;
    const have = new Map(stored.map(s => [`${s.kind}:${s.ref}`, s.content_hash]));
    return incoming.every(p => have.has(`${p.kind}:${p.ref}`) && have.get(`${p.kind}:${p.ref}`) === p.contentHash);
}

const asJsonb = (v) => (v == null ? null : JSON.stringify(v));

module.exports = {
    newId,
    newReleaseId,
    isNonEmptyString,
    isPlainObject,
    storeError,
    clientHandle,
    isBlueprintId,
    mapRow,
    largestEntity,
    assertManifestSize,
    normalizeNotes,
    mapReleaseRow,
    PIPELINE_RELEASE_COLUMNS,
    STAMP_COLUMNS,
    mapStampRow,
    asCount,
    META_COLUMNS,
    canRead,
    normalizeMembers,
    normalizePayloads,
    samePayloadSet,
    asJsonb,
};

/** @typedef {{ solution?: { key?: string, name?: string, description?: string, icon?: string, version?: number, entities?: Record<string, Array<Record<string, unknown>>> } } & Record<string, unknown>} BlueprintManifest */
