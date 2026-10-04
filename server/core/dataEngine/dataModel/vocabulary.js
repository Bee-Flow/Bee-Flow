/**
 * Data engine — the shared VOCABULARY: field/filter/aggregate enums, the caps
 * in DATA_LIMITS, the identifier grammars every other dataModel/ module
 * validates against, and the connector + mailbox vocabulary.
 *
 * LAYER: core/. This file has NO requires at all — literals only — so App
 * Studio and the automation datatables can share one vocabulary without either
 * feature depending on the other (server/layering.test.js forbids that edge).
 * The two connector constants deliberately do NOT live here: they are owned by
 * appStudio/connectors.js, the module that actually runs a connector, and
 * appStudio/dataModel/vocabulary.js re-exports them alongside everything below
 * so App Studio's import surface is unchanged.
 */

'use strict';

// ---------------------------------------------------------------------------
// Enumerations (exported — the FE runtime + query compiler share these)
// ---------------------------------------------------------------------------

const FIELD_TYPES = Object.freeze([
    'text', 'richtext', 'number', 'date', 'datetime', 'bool',
    'select', 'multiselect', 'relation', 'file', 'computed',
]);

// The negations sit beside their positives on purpose: an author who can say
// "contains" and cannot say "does not contain" writes the inverse as a second
// step, and a `notIn` expressed as N `neq` conditions is N rows of UI that the
// 50-filter cap eventually refuses.
const FILTER_OPS = Object.freeze([
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'notContains', 'startsWith', 'endsWith',
    'in', 'notIn', 'between', 'isNull', 'isNotNull',
]);

/**
 * Dataset ids the PLATFORM answers, not the app.
 *
 * A binding reaches the organisation's member list as
 * `{kind:'dataset', datasetId:'sys_org_members'}`. Using the existing dataset
 * kind rather than a new binding kind is deliberate: the client fetch layer,
 * the cache key and the scope collector already handle `dataset`, so nothing
 * on that path changes. What DOES change is that validate must not reject an
 * id the app's own dataset list has never heard of.
 *
 * The underscore matters. Cache invalidation keys off the source id and
 * assumes no id contains a colon (AppDataScope), so 'sys:org_members' would
 * quietly break refreshes — an id that looks tidier and behaves worse.
 *
 * Reading this list still requires the app to opt in (model.directory.orgMembers)
 * AND the viewer to be able to open the app. It is a route, not a grant.
 */
const RESERVED_DATASET_IDS = Object.freeze(['sys_org_members']);

// p50/p90 are nearest-rank percentiles, compiled with a window function rather
// than a SQLite aggregate (there isn't one). They exist because "median first
// response" is the number an operations dashboard actually reports — an average
// is skewed by one forgotten ticket.
const AGG_FNS = Object.freeze(['count', 'sum', 'avg', 'min', 'max', 'p50', 'p90']);
const PERCENTILE_FNS = Object.freeze({ p50: 0.5, p90: 0.9 });

// 'hour' makes a busiest-hours histogram expressible; without it the finest
// grain is a day and that chart degrades to something else entirely.
const DATE_BUCKETS = Object.freeze(['hour', 'day', 'week', 'month', 'quarter', 'year']);

// Access modes consumed by the RLS gateway. Defined here for a single
// vocabulary; enforcement lives in the sibling gateway wave.
const ACCESS_MODES = Object.freeze(['app', 'owner', 'role', 'none']);

/**
 * WAAR de rijen van een modeltabel echt staan — `model.tables[].source`.
 *
 * Er zijn twee soorten, en de eerste heeft geen `source`-blok:
 *
 *   afwezig                 de app bezit haar eigen opslag. Dit is de soort die
 *                           er altijd al was; een model zonder `source`
 *                           canonicaliseert byte-identiek en verandert nergens
 *                           van gedrag. Additief, dus.
 *   {kind:'datatable', …}   de rijen staan in een STUDIO-DATATABEL, buiten de
 *                           app, gedeeld met automatiseringen en andere apps.
 *
 * `datatableId` draagt hetzelfde `tbl_`-voorvoegsel als een modeltabel-id
 * (stores/datatableStore.newDatatableId mint 'tbl_' + 12 hex). De twee zijn
 * dus NIET uit elkaar te houden aan hun vorm — alleen aan waar ze staan. Vandaar
 * dat `source.kind` verplicht is en niet uit de id wordt afgeleid.
 *
 * `mode` kent precies twee waarden. Een derde is een FOUT en wordt nergens
 * stilzwijgend 'read': dat zou een typefout in een leesrecht veranderen dat
 * niemand ooit heeft aangevraagd, en de auteur zou een readwrite-tabel zien
 * die niet schrijft zonder dat het scherm dat zegt. Een ONTBREKENDE mode is
 * iets anders — daar is nooit om gevraagd, dus die versmalt naar 'read'
 * (canonicalize vult hem in).
 *
 * Net als bij `access` legt deze laag alleen de VORM vast. Het afdwingen van
 * 'read' bij een schrijfstap is de taak van de opslaglaag, precies zoals de
 * RLS-gateway `access` afdwingt.
 */
const TABLE_SOURCE_KINDS = Object.freeze(['datatable']);
const TABLE_SOURCE_MODES = Object.freeze(['read', 'readwrite']);
// De ENE mode die rijen mag veranderen. Als losse constante omdat drie lagen de
// vraag "mag hier geschreven worden" stellen — de validator (validate/refs.js
// checkTableWritable), de rechtenlaag (appStudio/datatableSource.js) en het
// scherm (TablesManager) — en drie keer een letterlijke 'readwrite' is drie
// plekken waar een vierde mode stilzwijgend als lezen of als schrijven wordt
// gelezen. Komt er ooit een derde mode bij, dan is dit de regel die meeverandert.
const WRITABLE_TABLE_SOURCE_MODE = 'readwrite';
// Gesloten sleutelset: een typefout ("datatableID", "readMode") wordt afgewezen
// in plaats van genegeerd. Dezelfde redenering als model.directory.
const TABLE_SOURCE_KEYS = Object.freeze(['kind', 'datatableId', 'mode']);
// De id-grammatica van een Studio-datatabel (stores/datatableStore.js).
const DATATABLE_ID_RE = /^tbl_[a-z0-9]{4,}$/;

// The RESERVED role key an anonymous visitor of a public app page carries (see
// appStudio/publicAccess.js). It is a fixed key rather than a configurable one
// so the RLS gateway can recognise it by name and DENY BY DEFAULT: every other
// role falls back to the table's access.default, and `app` — the default an
// ordinary table is created with — means "everyone who can open the app may
// read every row". Inheriting that would have made a public intake form hand
// every visitor the whole customer table. A table must therefore grant this
// role explicitly, per action, or it grants nothing.
const PUBLIC_ROLE_KEY = 'public';

const DATA_LIMITS = Object.freeze({
    MAX_TABLES_PER_APP: 50,
    // One connector = one action (the picker bulk-creates them from a
    // multi-select), so this cap is per-ACTION, not per-app-you-use. Gmail alone
    // ships ~15 actions; 20 would be spent on a single integration.
    MAX_CONNECTORS: 50,
    MAX_FIELDS_PER_TABLE: 100,
    MAX_ROWS_PER_TABLE: 100_000,
    MAX_ROWS_PER_APP: 500_000,
    MAX_DB_BYTES: 256 * 1024 * 1024,
    MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
    // Env-tunable (same idiom as STUDIO_APP_ATTACHMENT_TOTAL_BYTES in
    // mailboxAttachments.js): a CAD-order workload (~20 mailed files per order)
    // consumes rows far faster than the form-upload workloads the default was
    // sized for.
    MAX_ATTACHMENTS_PER_APP: parseInt(process.env.STUDIO_APP_MAX_ATTACHMENTS, 10) || 5000,
    // Not in the primary caps list but needed by select validation.
    MAX_SELECT_OPTIONS: 100,
    MAX_NAME_LEN: 120,
    MAX_COMPUTED_EXPR: 500,
});

// System columns present on every table — field keys may not collide with them.
const SYSTEM_COLUMNS = Object.freeze(['id', 'created_at', 'updated_at', 'created_by', 'org_id']);

// Table/field key grammar: lowercase, starts with a letter, ≤63 chars.
const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

// Identifier prefixes the engines reserve for themselves: Postgres owns pg_
// (catalogs, pg_temp/pg_toast magic), SQLite owns sqlite_ (sqlite_master,
// sqlite_sequence). A table or field key starting with either could shadow or
// collide with engine internals, so BOTH dialects refuse them at validation.
const RESERVED_KEY_PREFIX_RE = /^(pg_|sqlite_)/;

// Connector id grammar (mirrors tbl_/fld_): conn_<hex>.
const CONNECTOR_ID_RE = /^conn_[a-z0-9]{4,}$/;
// A declared viewer-param key: identifier, ≤64 chars. Placeholders inside a REST
// url template ({query}) must resolve to one of these.
const CONNECTOR_PARAM_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
// An integration/provider id on an integration_tool connector ('gmail',
// 'google-calendar'). Same grammar the connections API accepts for providers.
const CONNECTOR_INTEGRATION_ID_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/i;
// Field/header names that read like an INLINE secret. The only legal way to
// attach a credential to a connector is auth.credentialProvider (a reference the
// server resolves from the OWNER's credential store) — never a pasted value.
const CONNECTOR_SECRET_KEY_RE = /secret|passwo?rd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|bearer|authorization/i;
// Declared-param ceiling (author surface). The RUNTIME viewer-param cap lives in
// connectors.js; this bounds the persisted declaration.
const MAX_CONNECTOR_PARAMS = 20;
// Follow-up steps on a connector chain (`gmail_search → gmail_read →
// gmail_download_attachment`). Each step runs once per row of the previous one,
// so depth multiplies upstream calls — the runtime enforces a hard call budget
// on top of this (connectors.js MAX_CHAIN_CALLS).
const MAX_CHAIN_STEPS = 3;
// A source path on a chain binding or a synced field: `id`, `sender.email`,
// `attachments[].id`. Bounded and grammar-checked because it is persisted JSON
// that later drives a lookup on an untrusted upstream payload.
const SOURCE_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}(\[\])?(\.[a-zA-Z_][a-zA-Z0-9_]{0,63}(\[\])?){0,4}$/;
// How a chain step folds its result into the row it ran for.
const CHAIN_MERGE_MODES = Object.freeze(['extend', 'nest']);
// The complete key set a sync.dependents entry may carry — mode 'column' uses
// { tableId, retentionField }, mode 'cascade' uses { tableId, relationField,
// parentTableId, retentionCascade }. Closed so a typo'd key ("retentionfield")
// is refused instead of silently leaving the table outside the purge.
const DEPENDENT_KEYS = Object.freeze(['tableId', 'retentionField', 'relationField', 'parentTableId', 'retentionCascade']);
// How a sync writes rows into its table.
const SYNC_MODES = Object.freeze(['replace', 'upsert']);
// How the stored watermark is rendered into a request-side since-param.
const SYNC_INCREMENTAL_FORMATS = Object.freeze(['iso', 'unix', 'date']);
// A refresh cadence below this would hammer an upstream API from every replica
// for no practical gain; the job ticks once a minute regardless.
const MIN_SYNC_MINUTES = 15;

/**
 * Per-kind floors below the global one.
 *
 * 15 minutes is right for a REST feed or an automation, and far too slow for an
 * inbox — a support desk that notices a customer e-mail a quarter of an hour
 * late is not a support desk. A mailbox pull is cheap (one list call per tick
 * when nothing changed), so 2 minutes stays well inside both providers' quotas.
 * Kept as a per-kind override rather than a lower global floor so a REST
 * connector can never be pointed at someone's API every 2 minutes.
 */
const MIN_SYNC_MINUTES_BY_KIND = Object.freeze({ mailbox: 2 });

function minSyncMinutes(kind) {
    return MIN_SYNC_MINUTES_BY_KIND[kind] ?? MIN_SYNC_MINUTES;
}

// ── mailbox connector vocabulary ────────────────────────────────────────────
const MAILBOX_PROVIDERS = Object.freeze(['gmail', 'outlook']);
const MAILBOX_MODES = Object.freeze(['personal', 'shared']);
const MAILBOX_SHARED_MODES = Object.freeze(['delegated_mailbox', 'delivered_alias']);
// `folder` and `address` become URL SEGMENTS in /users/{address}/mailFolders/{folder}.
// These patterns are the path-traversal guard, not cosmetics.
const MAILBOX_FOLDER_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAILBOX_EMAIL_RE = /^[^\s@"'<>\\]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,24}$/i;
const MAX_MAILBOX_QUERY_LEN = 512;
const MAX_MAILBOX_CONNECTORS = 3;
const MAILBOX_KEY_FIELD = 'provider_message_id';
const MAILBOX_THREAD_KEY_FIELD = 'thread_key';
const MAX_MAILBOX_RETENTION_DAYS = 730;

module.exports = {
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
    CONNECTOR_ID_RE,
    CONNECTOR_PARAM_KEY_RE,
    CONNECTOR_INTEGRATION_ID_RE,
    CONNECTOR_SECRET_KEY_RE,
    MAX_CONNECTOR_PARAMS,
    MAX_CHAIN_STEPS,
    SOURCE_PATH_RE,
    CHAIN_MERGE_MODES,
    DEPENDENT_KEYS,
    SYNC_MODES,
    SYNC_INCREMENTAL_FORMATS,
    MIN_SYNC_MINUTES,
    MIN_SYNC_MINUTES_BY_KIND,
    minSyncMinutes,
    MAILBOX_PROVIDERS,
    MAILBOX_MODES,
    MAILBOX_SHARED_MODES,
    MAILBOX_FOLDER_RE,
    MAILBOX_EMAIL_RE,
    MAX_MAILBOX_QUERY_LEN,
    MAX_MAILBOX_CONNECTORS,
    MAILBOX_KEY_FIELD,
    MAILBOX_THREAD_KEY_FIELD,
    MAX_MAILBOX_RETENTION_DAYS,
};
