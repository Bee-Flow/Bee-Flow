// @typecheck
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
    'autonumber', 'json', 'user',
]);

/**
 * The field types after `computed` came after the frozen base (their marks and descriptions are
 * in vocabularySince.js DATA_VOCABULARY_MARKS.fieldTypes). A model that never names one plans,
 * compiles and renders exactly as before.
 *
 *   autonumber  a whole number the SERVER assigns on create (1, 2, 3 … per table); never written
 *               by a client, always unique. INTEGER on SQLite, BIGINT on Postgres.
 *   json        a JSON value, stored as JSON text in both dialects (like multiselect and file).
 *   user        the id of a member of the organisation, stored as text.
 *
 * All three are APP-ONLY: an automation datatable cannot hold them (datatableFields.js
 * DATATABLE_FIELD_TYPES leaves them out, vocabulary.lockstep.test.js pins that).
 */
const APP_ONLY_FIELD_TYPES = Object.freeze(['relation', 'computed', 'autonumber', 'json', 'user']);

/**
 * `field.format` on a text field (optional, a field option marked in vocabularySince.js): what
 * kind of text it holds. A value written to a field with a format is checked on every write
 * (core/dataEngine/fieldFormats.mts); the column stays TEXT, so adding or removing a format never
 * migrates anything.
 */
const TEXT_FORMATS = Object.freeze({ values: Object.freeze(['email', 'url', 'phone']) });

/**
 * `field.display` (optional, a field option marked in vocabularySince.js): how a value is SHOWN,
 * never how it is stored. Nothing of it reaches the DDL or the write path.
 *   currency   ISO 4217 code (three capital letters)  number and computed fields
 *   decimals   0 … MAX_DECIMALS                         number and computed fields
 *   unit       a short suffix ("kg", "h")               number and computed fields; not with currency
 *   dateStyle  one of DATE_STYLES (Intl dateStyle)       date and datetime fields
 */
const FIELD_DISPLAY = Object.freeze({
    keys: Object.freeze(['currency', 'decimals', 'unit', 'dateStyle']),
    dateStyles: Object.freeze(['short', 'medium', 'long', 'full']),
    MAX_DECIMALS: 10,
    MAX_UNIT_LEN: 16,
});

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
// countDistinct (COUNT(DISTINCT field)) came after the base: it is appended and marked in vocabularySince.js.
const AGG_FNS = Object.freeze(['count', 'sum', 'avg', 'min', 'max', 'p50', 'p90', 'countDistinct']);
const PERCENTILE_FNS = Object.freeze({ p50: 0.5, p90: 0.9 });

// 'hour' makes a busiest-hours histogram expressible; without it the finest
// grain is a day and that chart degrades to something else entirely.
const DATE_BUCKETS = Object.freeze(['hour', 'day', 'week', 'month', 'quarter', 'year']);

/**
 * Aggregate descriptor keys that came after App Studio schema version 2. Each is
 * optional and absent from a descriptor that does not use it.
 *   groupBy[].binWidth     a number column folded onto steps of this width
 *   groupBy[].relatedField group by a column of the row a relation field points
 *                          at, read under that table's own row rules
 *   groupFilter            [{ field: <aggregate alias>, op, value: number }]:
 *                          keep only the groups whose aggregate passes (HAVING).
 *                          Not called `having`: a stored descriptor carrying a
 *                          `having` key has always been read without it.
 */
const GROUP_FILTER_OPS = Object.freeze(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
// Validity limits of a descriptor (not runtime budgets).
const AGGREGATE_LIMITS = Object.freeze({
    MAX_GROUP_FILTERS: 5,
    MAX_RELATED_GROUP_BY: 3,
    MAX_BIN_WIDTH: 1_000_000_000,
});

/**
 * Reading through a relation, and the columns a record read returns. All
 * optional, after App Studio schema version 2, and absent from a read that
 * does not use them:
 *   expand   [{ field: <relation field>, pick?: [<column of the related table>], as? }]
 *            the related row of each record, one relation deep, read with a
 *            second query under the related table's own row rules
 *   fields   [<column>]: only these columns (and `id`) leave the server
 *   filter   { field: '<relation field>.<column of the related table>', op, value }
 * Validity limits of a read (not runtime budgets).
 */
const RELATION_READ_LIMITS = Object.freeze({
    MAX_EXPAND: 5,
    MAX_EXPAND_PICK: 20,
    MAX_FIELDS: 100,
    MAX_RELATION_FILTERS: 5,
});
// The column an expansion lands in when the entry names none: <relation field> + this.
const EXPAND_DEFAULT_SUFFIX = '_record';
// The key of an expanded row that carries the relation's display value (relation.displayField).
const EXPAND_LABEL_KEY = '_label';

// Access modes consumed by the RLS gateway. Defined here for a single
// vocabulary; enforcement lives in the sibling gateway wave.
const ACCESS_MODES = Object.freeze(['app', 'owner', 'role', 'none']);

/**
 * WHERE the rows of a model table actually live: `model.tables[].source`.
 *
 * There are two kinds, and the first has no `source` block:
 *
 *   absent                  the app owns its own storage. This is the kind that
 *                           was always there; a model without `source` canonicalises
 *                           byte-identically and changes nothing in behaviour. Additive, therefore.
 *   {kind:'datatable', …}   the rows are in a STUDIO DATATABLE, outside the app, shared
 *                           with automations and other apps.
 *
 * `datatableId` carries the same `tbl_` prefix as a model-table id
 * (stores/datatableStore.newDatatableId mints 'tbl_' + 12 hex). The two therefore CANNOT be
 * told apart by their form, only by where they live. That is why `source.kind` is required
 * and is not derived from the id.
 *
 * `mode` knows exactly two values. A third is an ERROR and never silently becomes 'read':
 * that would turn a typo into a read right that nobody ever asked for, and the author would
 * see a readwrite table that does not write without the screen saying so. A MISSING mode is
 * something else: nobody asked for one, so it narrows to 'read' (canonicalize fills it in).
 *
 * As with `access`, this layer checks only the SHAPE. Enforcing 'read' on a write step is the
 * task of the storage layer, just as the RLS gateway enforces `access`.
 */
const TABLE_SOURCE_KINDS = Object.freeze(['datatable']);
const TABLE_SOURCE_MODES = Object.freeze(['read', 'readwrite']);
// The ONE mode that may change rows. As a separate constant because three layers ask the
// question "may one write here": the validator (validate/refs.js checkTableWritable), the rights
// layer (appStudio/datatableSource.js) and the screen (TablesManager). Three times a literal
// 'readwrite' is three places where a fourth mode would silently be read as read or as write.
// If a third mode ever arrives, this is the rule that changes along with it.
const WRITABLE_TABLE_SOURCE_MODE = 'readwrite';
// Closed key set: a typo ("datatableID", "readMode") is refused instead of ignored.
// The same reasoning as model.directory.
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

/**
 * What a row rule can say about the person reading: `viewer.<key>`.
 *
 * `list: true` is a list of text values and only stands on the right of `in`
 * (`record.team in viewer.groups`); every other attribute is one value and
 * compares with `==` and friends. `resolved: true` is read from the user's own
 * row at use (appStudio/viewerAttributes.mts), never from the request; a path
 * that did not resolve it leaves it out and the rule then matches no row.
 * The attributes added after the frozen base are marked in vocabularySince.js
 * (family `rowRule`), which is how the App Studio builder learns of them.
 *
 *   id               the person's user id (an anonymous visitor: the visitor id)
 *   role             their role in this app
 *   organizationId   kept as it is: the session's organisation on the data
 *                    routes, the app's in server steps, null on a public page
 *   orgId            the organisation of the person's own account, the same on
 *                    every path; null for an anonymous visitor
 *   email            the address of the person's account
 *   groups           the ids of the groups the person is a member of (the keys
 *                    roleMapping.byGroup uses)
 */
const VIEWER_ATTRIBUTES = Object.freeze([
    Object.freeze({ key: 'id' }),
    Object.freeze({ key: 'role' }),
    Object.freeze({ key: 'organizationId' }),
    Object.freeze({ key: 'orgId', resolved: true }),
    Object.freeze({ key: 'email', resolved: true }),
    Object.freeze({ key: 'groups', resolved: true, list: true }),
]);

/**
 * The keys of a per-operation row rule: `rowFilters[role]` as `{ read, update, delete }`
 * instead of one rule. An operation that is left out follows the rule for `read`, so an
 * entry is never broader than its read rule by omission; `true` is the rule for "every row".
 */
const ROW_FILTER_OPERATIONS = Object.freeze(['read', 'update', 'delete']);

/**
 * The words of a row rule beyond comparisons of `record.<field>` and literals: every
 * `viewer.<attribute>`, then the forms added after the frozen base. The base words come
 * first; a word after them is marked in vocabularySince.js (family `rowRule`).
 *
 *   in             `record.<text field> in viewer.<list attribute>`
 *   perOperation   `rowFilters[role]` as `{ read, update, delete }` (ROW_FILTER_OPERATIONS)
 */
const ROW_RULE_WORDS = Object.freeze([...VIEWER_ATTRIBUTES.map((spec) => `viewer.${spec.key}`), 'in', 'perOperation']);

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

/**
 * Field rules (optional field options, marked in vocabularySince.js): `field.validation` and
 * `field.dynamicDefault`.
 *
 * Both are APPLICATION-level. Nothing of them reaches the DDL: a rule is checked by
 * core/dataEngine/fieldRules.mts before a write is compiled, so adding, changing or removing one
 * never migrates a column, and rows written before the rule existed are never re-checked. A field
 * without either key writes exactly as before.
 *
 *   validation      { min, max }               number fields
 *                   { minLength, maxLength }   text fields, counted in characters
 *                   { pattern }                text fields; compiled through core/text/userPattern
 *                   { enforceOptions: true }   select / multiselect: only the listed options
 *                   { message }                replaces the generated sentence for every rule
 *   dynamicDefault  filled on CREATE when the value is missing or empty, per field type:
 *                   now → datetime, today → date (UTC), currentUser.id → text
 */
const FIELD_VALIDATION = Object.freeze({
    keys: Object.freeze(['min', 'max', 'minLength', 'maxLength', 'pattern', 'enforceOptions', 'message']),
});
const DYNAMIC_DEFAULTS = Object.freeze({
    // value → the field types it may sit on
    types: Object.freeze({
        now: Object.freeze(['datetime']),
        today: Object.freeze(['date']),
        'currentUser.id': Object.freeze(['text', 'user']),
    }),
});
// Definition limits for the rules above (they decide whether a MODEL is valid, so constants).
const FIELD_RULE_LIMITS = Object.freeze({
    MAX_PATTERN_LEN: 500,
    MAX_MESSAGE_LEN: 200,
    MAX_LENGTH: 1_000_000,
});

// System columns present on every table — field keys may not collide with them.
const SYSTEM_COLUMNS = Object.freeze(['id', 'created_at', 'updated_at', 'created_by', 'org_id']);

// Table/field key grammar: lowercase, starts with a letter, ≤63 chars.
const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

// Identifier prefixes the engines reserve for themselves: Postgres owns pg_
// (catalogs, pg_temp/pg_toast magic), SQLite owns sqlite_ (sqlite_master,
// sqlite_sequence). A table or field key starting with either could shadow or
// collide with engine internals, so BOTH dialects refuse them at validation.
// pragma_ is SQLite's table-valued pragma namespace, which the page statement
// guard refuses in queries; reserving it here refuses such a key at design time.
const RESERVED_KEY_PREFIX_RE = /^(pg_|sqlite_|pragma_)/;

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
    APP_ONLY_FIELD_TYPES,
    TEXT_FORMATS,
    FIELD_DISPLAY,
    FILTER_OPS,
    RESERVED_DATASET_IDS,
    AGG_FNS,
    PERCENTILE_FNS,
    DATE_BUCKETS,
    GROUP_FILTER_OPS,
    AGGREGATE_LIMITS,
    RELATION_READ_LIMITS,
    EXPAND_DEFAULT_SUFFIX,
    EXPAND_LABEL_KEY,
    ACCESS_MODES,
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
    TABLE_SOURCE_KEYS,
    DATATABLE_ID_RE,
    PUBLIC_ROLE_KEY,
    VIEWER_ATTRIBUTES,
    ROW_FILTER_OPERATIONS,
    ROW_RULE_WORDS,
    DATA_LIMITS,
    FIELD_VALIDATION,
    DYNAMIC_DEFAULTS,
    FIELD_RULE_LIMITS,
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
