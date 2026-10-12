// @typecheck
/**
 * Datatables — the ROW storage, one Postgres schema per SCOPE.
 *
 * Exposes the same frozen facade studioAppDbStore does (query/exec/batch/
 * applyMigration/getSchemaStamp/schema/sizeBytes/reset/flush/invalidate/
 * closeAll) so quota helpers, tests and compiler consumers stay interchangeable
 * between the two.
 *
 * ── POSTGRES ONLY. NEVER THE SQLITE BLOB ENGINE ─────────────────────
 * studioAppDbStore picks its engine from STUDIO_APP_ENGINE. This module must
 * NOT — it always builds createPgAppEngine, and there is a test pinning that.
 * The sqlite blob engine is disqualified on three independent grounds:
 *
 *   1. It POISONS the handle when another replica's metadata sha moves under it
 *      (sqliteBlobEngine.js "refusing to overwrite"). An org-wide table written
 *      by concurrent runs on two replicas would permanently error.
 *   2. Its metadata SQL hard-codes `user_id`. An org-owned entity matches zero
 *      rows and takes the MISSING branch: it uploads the blob and SILENTLY
 *      skips the metadata.
 *   3. Its sha-gated debounced flush is a ~5-second durability window. A step
 *      that reads back what the previous step just wrote would miss it.
 *
 * Requiring Postgres costs nothing: docker-compose.from-registry puts postgres
 * in the `core` profile, so it is unconditionally present, and this engine
 * creates a schema inside the existing beeflow_core database — no new
 * container, no new connection string. Critically it also does NOT require
 * flipping STUDIO_APP_ENGINE=pg, which would trip the per-app interlock in
 * studioAppDbStore and 503 every existing sqlite app.
 *
 * ── TRUST BOUNDARY ──────────────────────────────────────────────────
 * Module-internal, exactly like studioAppDbStore. query/exec/batch/
 * applyMigration are only ever called with SQL that core/dataEngine/
 * queryCompiler generated from a validated table descriptor and a
 * closed-vocabulary request. No route hands them client SQL, and no route ever
 * should. The datatable step type has no `sql` field, and the validator rejects
 * one by name.
 *
 * ── THE TENANT IS A SCOPE KEY ───────────────────────────────────────
 * The engine's `ownerId` and `entityId` are both the SCOPE KEY — `org:<orgId>`
 * for an organisation's tables, `user:<userId>` for one account's PERSONAL
 * tables. The unit of storage is the scope, not a single table. Row-level
 * scoping to a person inside a shared table is a separate concern, done by the
 * access filter the compiler ANDs into every query.
 *
 * The key is one opaque string rather than a pair because `schemaFor` is
 * synchronous and the engine's ownership memo is a Map — both need one value.
 * It is parsed, never concatenated at a call site: a caller that passed a bare
 * org id would hash to a DIFFERENT schema, and applyMigration's CREATE SCHEMA
 * IF NOT EXISTS would mint it empty while the tenant's real rows sat elsewhere.
 * assertScopeUsable therefore refuses anything that is not a well-formed key.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { createPgAppEngine } = require('./lib/pgAppEngine');

// The engine calls assertAccess INSIDE its transaction and BEFORE search_path
// is narrowed, and it returns before its own built-in ownership cache — so
// without a memo here every datatable operation pays a round trip. 60s matches
// the engine's own OWNERSHIP_TTL_MS. The entry also carries the resolved SCHEMA
// NAME, because that answer costs the same round trip.
const ACCESS_TTL_MS = 60_000;
const _accessMemo = new Map();   // scope key → { ts, schema, legacy }

// The pre-hash name: 'dtorg_' + the org id, verbatim.
const LEGACY_ORG_PREFIX = 'dtorg_';

const SCOPE_KINDS = new Set(['org', 'user']);

/** `{kind:'org', id:'acme'}` → `'org:acme'`. The engine's tenant handle. */
function scopeKey(scope) {
    if (!scope || !SCOPE_KINDS.has(scope.kind) || !scope.id) {
        throw new Error('a datatable scope is {kind:\'org\'|\'user\', id}');
    }
    return `${scope.kind}:${scope.id}`;
}

/** The org half of the pair, for the callers that only ever hold an org id. */
function orgScopeKey(organizationId) {
    return scopeKey({ kind: 'org', id: organizationId });
}

/**
 * `'org:acme'` → `{kind:'org', id:'acme'}`, or null when it is not a scope key.
 *
 * Split on the FIRST colon only: an org id is a slug of the organisation name
 * and a user id can be an OAuth `sub`, so neither is guaranteed colon-free.
 */
function parseScopeKey(key) {
    if (typeof key !== 'string') return null;
    const i = key.indexOf(':');
    if (i <= 0) return null;
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    if (!SCOPE_KINDS.has(kind) || !id) return null;
    return { kind, id };
}

/**
 * The physical schema name for one tenant.
 *
 * A HASH, not the id, because an org id is a slug of the organisation NAME
 * (auth/accountProvisioning.slugifyOrgId) and Postgres truncates every
 * identifier to 63 bytes even when it is quoted. `'dtorg_' + orgId` therefore
 * collapses two organisations whose ids share 57 leading characters into ONE
 * schema, and they then read and overwrite each other's rows. Reproduced on a
 * real Postgres; latent only because org names happen to be short today.
 *
 * 'dt_' + 40 hex = 43 fixed characters, so the length can never depend on the
 * caller again — including for the user ids (an OAuth `sub`, or a raw e-mail
 * address) a personal scope feeds it.
 *
 * scopeKind is part of the digest so an org and a user that happen to share an
 * id can never land in the same schema.
 */
function schemaNameFor(scopeKind, scopeId) {
    const digest = crypto.createHash('sha256')
        .update(`${scopeKind}\0${scopeId}`, 'utf8')
        .digest('hex');
    return 'dt_' + digest.slice(0, 40);
}

/** A Postgres quoted identifier, for the to_regnamespace() probe below. */
function quoted(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * There is no ownership question to ask — the scope IS the owner — but there IS
 * an existence question: a scope with no model row has no schema, and every
 * later statement would fail with a confusing "schema does not exist". Assert
 * it once, cheaply, and let the engine's 404 shape carry the message.
 *
 * The same round trip resolves the tenant's SCHEMA NAME, because both facts are
 * needed before search_path is narrowed and asking twice would double the cost
 * of every datatable operation.
 *
 * `ownerId` is not compared to `entityId`: the shared engine supports owner ≠
 * entity (studioAppDbStore keys `app_<appId>` with ownership read from
 * `studio_apps.user_id`), and a personal scope is exactly that shape. What IS
 * checked is that the entity is a well-formed scope key — a bare org id would
 * otherwise hash to a schema nobody's rows are in and be created empty.
 *
 * ── THE LEGACY FALLBACK IS LOAD-BEARING ─────────────────────────────
 * Prefer the hashed name; fall back to `dtorg_<id>` only when THAT exists and
 * the hashed one does not; a brand-new tenant gets the hashed name. Without the
 * fallback a half-failed rename does not 404 — `pgAppEngine.applyMigration`
 * runs CREATE SCHEMA IF NOT EXISTS, so the next schema save would silently
 * create an EMPTY new schema while the organisation's real rows sat orphaned in
 * `dtorg_<slug>` with no metadata row describing them, no access filter
 * guarding them, no retention reaching them and no UI able to see them.
 * Keep it for the whole release that contains the rename migration. It applies
 * to ORG scopes only — a personal scope never had a pre-hash name.
 */
async function assertScopeUsable(client, ownerId, entityId) {
    const scope = parseScopeKey(entityId);
    if (!scope) {
        const e = new Error('Datatable rows are addressed by a scope key, not by a bare id');
        e.status = 400;
        throw e;
    }
    const cached = _accessMemo.get(entityId);
    // A LEGACY resolution is deliberately NOT cached: the rename migration can
    // land on another replica at any moment, and a stale `dtorg_<id>` would
    // make applyMigration's CREATE SCHEMA IF NOT EXISTS mint an empty schema
    // beside the renamed one — precisely the orphan this change removes. Once a
    // tenant resolves to the hashed name the answer is permanent, so the memo
    // does its job for every tenant that has been renamed.
    if (cached && !cached.legacy && (Date.now() - cached.ts) < ACCESS_TTL_MS) return;
    const hashed = schemaNameFor(scope.kind, scope.id);
    const legacy = scope.kind === 'org' ? LEGACY_ORG_PREFIX + scope.id : null;
    // Selecting FROM datatable_models keeps "no model row" as "no rows", which
    // is the 404 below; the two probes ride along as columns.
    const res = await client.query(
        `SELECT to_regnamespace($3::text) IS NOT NULL AS has_hashed,
                to_regnamespace($4::text) IS NOT NULL AS has_legacy
           FROM datatable_models WHERE scope_kind = $1 AND scope_id = $2`,
        [scope.kind, scope.id, quoted(hashed), legacy === null ? null : quoted(legacy)],
    );
    if (!res.rows || res.rows.length === 0) {
        const e = new Error(scope.kind === 'org'
            ? 'This organisation has no datatables yet'
            : 'This account has no datatables yet');
        e.status = 404;
        throw e;
    }
    const row = res.rows[0] || {};
    const useLegacy = !row.has_hashed && !!row.has_legacy && !!legacy;
    _accessMemo.set(entityId, {
        ts: Date.now(),
        schema: useLegacy ? legacy : hashed,
        legacy: useLegacy,
    });
}

/** The resolved schema name for a scope key, or the hashed default. */
function schemaFor(key) {
    const cached = _accessMemo.get(key);
    if (cached) return cached.schema;
    const scope = parseScopeKey(key);
    // Synchronous by contract (the engine calls it while building SQL), so it
    // cannot go and look. Throwing is the only fail-closed answer: returning a
    // guess would name a schema no tenant's rows are in, and the next
    // applyMigration would create it.
    if (!scope) throw new Error('Datatable rows are addressed by a scope key, not by a bare id');
    return schemaNameFor(scope.kind, scope.id);
}

/**
 * Make sure the memo holds a schema name for this scope.
 *
 * `schema()` and `sizeBytes()` in the engine compute schemaFor() BEFORE they
 * open their transaction, so they would read an unresolved memo and report on
 * the hashed schema of a tenant that still lives under the legacy name — an
 * empty table list and a zero size, with no error anywhere.
 */
async function ensureScopeResolved(entityId) {
    const cached = _accessMemo.get(entityId);
    if (cached && !cached.legacy && (Date.now() - cached.ts) < ACCESS_TTL_MS) return;
    await assertScopeUsable({ query: (sql, params) => db.run(sql, params) }, entityId, entityId);
}

/** Mirror the measured size so a list read stays join-free. Fire-and-forget. */
function mirrorScopeSize(entityId, _ownerId, bytes) {
    const scope = parseScopeKey(entityId);
    if (!scope) return Promise.resolve();
    return db.run(
        `UPDATE datatable_models SET size_bytes = $1, updated_at = NOW()
          WHERE scope_kind = $2 AND scope_id = $3`,
        [bytes, scope.kind, scope.id],
    );
}

/** Zero the metadata when the schema is dropped. Runs in the engine's tx. */
function clearScopeMeta(client, entityId) {
    const scope = parseScopeKey(entityId);
    if (!scope) return Promise.resolve();
    return client.query(
        `UPDATE datatable_models SET size_bytes = 0, schema_stamp = 0, updated_at = NOW()
          WHERE scope_kind = $1 AND scope_id = $2`,
        [scope.kind, scope.id],
    );
}

const engine = createPgAppEngine({
    runQuery: db.run,
    getClient: db.getClient,
    logPrefix: 'DatatableDB',
    entityLabel: 'Scoped Datatables',
    // Synchronous by contract (the engine calls it while building SQL), so it
    // reads the answer assertScopeUsable already resolved on the transaction's
    // own client. A brand-new tenant has no memo entry and no schema either, so
    // the hashed name is the right default.
    schemaFor,
    assertAccess: assertScopeUsable,
    mirrorSize: mirrorScopeSize,
    clearMeta: clearScopeMeta,
});

/** Drop the access memo for a scope — call on archive, delete or schema reset. */
function invalidate(key) {
    if (key) _accessMemo.delete(key);
    else _accessMemo.clear();
    return engine.invalidate ? engine.invalidate(key) : undefined;
}

/**
 * Delete ONE table — its metadata AND its rows — in a single transaction.
 *
 * Lives here rather than in datatableStore because this module owns the
 * physical side; the metadata store deliberately holds no engine dependency,
 * so it takes the DDL as a callback and this is the one place that supplies it.
 *
 * The DROP rides the metadata transaction because the route used to commit the
 * metadata and only THEN run the DDL: a lock timeout there left a Postgres
 * table full of personal data that no metadata described, no access filter
 * guarded and no UI could reach — and the route answered `{ok:true}` anyway.
 *
 * @param {{kind:'org'|'user', id:string}} scope
 * @returns {Promise<boolean>} false when there was no such table to delete.
 */
async function dropDatatable(datatableId, scope, { managedWrite = null } = {}) {
    // Required lazily so the metadata half is not dragged in at load time.
    const datatableStore = require('./datatableStore');
    const { migrationPlan } = require('../core/dataEngine/dataModel/migrationPlan');
    const key = scopeKey(scope);
    return datatableStore.deleteDatatable(datatableId, scope, {
        managedWrite,
        dropPhysical: (client, { before, next, modelVersion }) => {
            // The dialect is stated, never inherited: the App Studio engine flag
            // is a process global and these rows are always in Postgres.
            //
            // onlyTableIds is not decoration: the diff runs over the WHOLE scope
            // model, so without it a delete would happily carry out whatever
            // else the two model documents disagree about — someone's
            // half-finished DROP COLUMN included.
            const plan = migrationPlan(before, next, { dialect: 'pg', onlyTableIds: [datatableId] });
            if (!plan.length) return undefined;
            return engine.applyMigration(key, key, plan, { client, targetVersion: modelVersion });
        },
    });
}

/** Table list + columns as Postgres has them. Resolves the schema name first. */
async function schema(ownerId, entityId) {
    await ensureScopeResolved(entityId);
    return engine.schema(ownerId, entityId);
}

/** On-disk bytes of the tenant's schema. Resolves the schema name first. */
async function sizeBytes(ownerId, entityId) {
    await ensureScopeResolved(entityId);
    return engine.sizeBytes(ownerId, entityId);
}

module.exports = {
    query: engine.query,
    exec: engine.exec,
    batch: engine.batch,
    applyMigration: engine.applyMigration,
    getSchemaStamp: engine.getSchemaStamp,
    schema,
    sizeBytes,
    reset: engine.reset,
    flush: engine.flush,
    invalidate,
    dropDatatable,
    closeAll: engine.closeAll,
    schemaNameFor,
    scopeKey,
    orgScopeKey,
    parseScopeKey,
    LEGACY_ORG_PREFIX,
    // test-only
    _accessMemo,
    _assertScopeUsable: assertScopeUsable,
    _schemaFor: schemaFor,
};
