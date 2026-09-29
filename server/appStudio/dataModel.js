/**
 * App Studio v2 — DATA MODEL contract (single source of truth).
 *
 * This is the analog of componentSpecs.js, but for the DATA ENGINE (per-app
 * database) rather than the component tree. A data model is validated JSON
 * describing an app's tables, fields, roles and access rules; from it we derive
 * — without drift — the SQLite DDL that materialises the per-app database
 * (studioAppDbStore.js) and, in a sibling wave, the query compiler + RLS
 * gateway.
 *
 * MODEL SHAPE
 *   {
 *     modelVersion: 1,
 *     tables: [{
 *       id, key, name, icon,
 *       source?: { kind:'datatable', datatableId, mode:'read'|'readwrite' },
 *       fields: [{ id, key, type, subtype?, required, unique, default, options?, relation?, computed? }],
 *       access: { default, roles: {}, rowFilters: {} }
 *     }],
 *     roles: [{ key, label }],
 *     roleMapping: { default, byGroup: {} }
 *   }
 *
 * The `access` / roles / rowFilters shape is CONSUMED by the RLS gateway
 * (sibling wave). We define and canonicalize it here but do NOT enforce it —
 * enforcement is the gateway's job.
 *
 * TABLE SOURCE (`source`) — de tweede tabelsoort
 *   Zonder `source` bezit de app haar eigen opslag: de soort die hieronder
 *   onder PHYSICAL SCHEMA staat beschreven, en de enige die er tot nu toe was.
 *   Met `source = {kind:'datatable', datatableId, mode}` staan de rijen in een
 *   Studio-datatabel, buiten de app. Deze laag legt alleen de VORM vast —
 *   dezelfde afspraak als bij `access`, waar de RLS-gateway het afdwingen doet.
 *
 * PHYSICAL SCHEMA
 *   Every table is a SQLite table named by its (mutable) `key`; every field is
 *   a column named by its (mutable) `key`. Stable identity for migration
 *   diffing is the `id` (tbl_… / fld_…), so a key change is a real
 *   RENAME rather than a drop+add. Five system columns lead every table:
 *
 *     id         TEXT PRIMARY KEY   — record id (rec_…)
 *     created_at TEXT
 *     updated_at TEXT
 *     created_by TEXT               — the RLS anchor (row owner)
 *     org_id     TEXT
 *
 *   Unique constraints are expressed as separate CREATE UNIQUE INDEX
 *   statements (never inline UNIQUE) named by stable ids — so a column can be
 *   dropped by first dropping its index (SQLite forbids DROP COLUMN on an
 *   indexed column). Same-db relations get a real FOREIGN KEY.
 *
 * SECURITY
 *   The only free-form SQL a model can carry is a `computed` field's
 *   expression. To keep it out of generated DDL, computed fields are read-time
 *   by default (no physical column). A `computed.stored:true` field is emitted
 *   as a GENERATED … STORED column ONLY at table-create time, and only after
 *   its expression passes a conservative validator (validateDataModel). All
 *   identifiers are constrained by KEY_RE and quoted, so table/field keys can
 *   never inject.
 */

'use strict';

// The contract itself is split by concern under dataModel/ — vocabulary, id
// minting, DDL, migration planning, tolerant replay, validation and
// canonicalization. This file stays the single import path for all of it.
const {
    CONNECTOR_KINDS,
    FIELD_TYPES,
    FILTER_OPS,
    RESERVED_DATASET_IDS,
    AGG_FNS,
    PERCENTILE_FNS,
    DATE_BUCKETS,
    ACCESS_MODES,
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
    TABLE_SOURCE_KEYS,
    DATATABLE_ID_RE,
    PUBLIC_ROLE_KEY,
    DATA_LIMITS,
    SYSTEM_COLUMNS,
    KEY_RE,
    RESERVED_KEY_PREFIX_RE,
    MAX_CHAIN_STEPS,
    CHAIN_MERGE_MODES,
    SYNC_MODES,
    SYNC_INCREMENTAL_FORMATS,
    MIN_SYNC_MINUTES,
    MIN_SYNC_MINUTES_BY_KIND,
    minSyncMinutes,
    SOURCE_PATH_RE,
    MAILBOX_PROVIDERS,
    MAILBOX_MODES,
    MAILBOX_SHARED_MODES,
    MAILBOX_KEY_FIELD,
    MAILBOX_THREAD_KEY_FIELD,
    MAX_MAILBOX_CONNECTORS,
    MAX_MAILBOX_QUERY_LEN,
    MAX_MAILBOX_RETENTION_DAYS,
} = require('./dataModel/vocabulary');
const { newTableId, newFieldId, newConnectorId, newRecordId } = require('./dataModel/ids');
const {
    sqliteType,
    pgType,
    uniqueIndexName,
    isCreatePhysical,
    isAlterPhysical,
    ddlForTable,
    addColumnDdl,
} = require('./dataModel/ddl');
const { migrationPlan } = require('./dataModel/migrationPlan');
const { applyPlanTolerantly } = require('./dataModel/tolerantDdl');
const { validateDataModel } = require('./dataModel/modelValidate');
const { canonicalizeDataModel, emptyDataModel } = require('./dataModel/canonicalize');

module.exports = {
    // Enums / limits
    FIELD_TYPES,
    FILTER_OPS,
    RESERVED_DATASET_IDS,
    AGG_FNS,
    PERCENTILE_FNS,
    DATE_BUCKETS,
    ACCESS_MODES,
    // Tabelbron — de tweede tabelsoort (model.tables[].source). Zie
    // core/dataEngine/dataModel/vocabulary.js voor waarom `mode` twee waarden
    // kent en een derde een fout is.
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
    TABLE_SOURCE_KEYS,
    DATATABLE_ID_RE,
    PUBLIC_ROLE_KEY,
    DATA_LIMITS,
    SYSTEM_COLUMNS,
    KEY_RE,
    // Ids
    newTableId,
    newFieldId,
    newConnectorId,
    newRecordId,
    // Connector vocabulary (re-exported for sibling wiring / tests)
    CONNECTOR_KINDS,
    MAX_CHAIN_STEPS,
    CHAIN_MERGE_MODES,
    SYNC_MODES,
    SYNC_INCREMENTAL_FORMATS,
    MIN_SYNC_MINUTES,
    MIN_SYNC_MINUTES_BY_KIND,
    minSyncMinutes,
    SOURCE_PATH_RE,
    // Mailbox connector vocabulary
    MAILBOX_PROVIDERS,
    MAILBOX_MODES,
    MAILBOX_SHARED_MODES,
    MAILBOX_KEY_FIELD,
    MAILBOX_THREAD_KEY_FIELD,
    MAX_MAILBOX_CONNECTORS,
    MAX_MAILBOX_QUERY_LEN,
    MAX_MAILBOX_RETENTION_DAYS,
    // Contract
    validateDataModel,
    canonicalizeDataModel,
    emptyDataModel,
    // DDL
    sqliteType,
    pgType,
    ddlForTable,
    migrationPlan,
    applyPlanTolerantly,
    RESERVED_KEY_PREFIX_RE,
    // Internal helpers (exported for tests)
    _uniqueIndexName: uniqueIndexName,
    _isCreatePhysical: isCreatePhysical,
    _isAlterPhysical: isAlterPhysical,
    _addColumnDdl: addColumnDdl,
};
