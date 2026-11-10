// @typecheck strict
/**
 * Data engine — the connector + mailbox part of the shared vocabulary (dataModel/vocabulary.js
 * re-exports every name, so callers keep importing from there).
 *
 * LAYER: core/. Literals only, like vocabulary.js: no requires.
 */

'use strict';

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
/** @type {Readonly<Record<string, number>>} */
const MIN_SYNC_MINUTES_BY_KIND = Object.freeze({ mailbox: 2 });

/**
 * @param {string} kind  the connector kind
 * @returns {number}
 */
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
