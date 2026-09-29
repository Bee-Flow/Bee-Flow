/**
 * THE SOURCE REGISTRY — the one module routes, jobs and runners require to
 * ask "does this table mirror something, and how do I refresh or write it?"
 *
 * A datatable whose ROWS come from somewhere else carries a `managed_kind`
 * naming its source kind (dataModel/managedTables.js is the contract). Each
 * kind has an ADAPTER (`<kind>/adapter.js`) with one interface — sync,
 * write-through, linking, events, the public projection of its `source`
 * block — and the shared engine under ./mirror does everything that is the
 * same for all of them. Consumers never string-compare a kind: they ask
 * here, so the second kind (a spreadsheet file) reached every write site,
 * the ticker, the retention sweep and the builder badges without any of
 * them learning its name.
 *
 * ── LAZY BY DESIGN ──────────────────────────────────────────────────
 * Every kind is a getter that requires its adapter on FIRST USE. Requiring
 * the registry loads neither kind: the ticker's unit test stubs only the
 * Nextcloud sync module, and a spreadsheet adapter that pulled its provider
 * clients in at load would drag Google, Graph and WebDAV into a test about
 * an advisory lock. `SOURCE_KINDS` is the same literal list stores/
 * datatableStore.js keeps (a store may not require core/ — layering.test.js);
 * index.test.js pins the two against each other and against the kinds
 * managedTables.js marks `fieldsFromSource`.
 */

'use strict';

const { managedKindSpec } = require('../dataModel/managedTables');

const KINDS = Object.freeze({
    get nextcloud_table() { return require('./nextcloudTable/adapter'); },
    get spreadsheet_file() { return require('./spreadsheetFile/adapter'); },
});

const SOURCE_KINDS = Object.freeze(Object.keys(KINDS));

function isSourceKind(kind) {
    return typeof kind === 'string' && SOURCE_KINDS.includes(kind);
}

/** The adapter for a kind. Throws on an unknown kind — a caller that got here has a table row saying so. */
function adapterFor(kind) {
    if (!isSourceKind(kind)) throw new Error(`unknown source kind: ${String(kind)}`);
    return KINDS[kind];
}

/** The adapter for a table's kind, or null for an ordinary table. */
function sourceOf(table) {
    const kind = table && table.managedKind;
    return isSourceKind(kind) ? KINDS[kind] : null;
}

/**
 * Does this datatable mirror an external source? A pure lookup on the kind —
 * it loads no adapter, so a phase or a list view may ask it for every row
 * without dragging a source's clients in (`sourceOf` is for callers that go
 * on to use the adapter).
 */
function isSourceMirror(table) {
    return isSourceKind(table && table.managedKind);
}

/** One full refresh pass (the adapter's sync.syncRows). */
function syncRows(table, opts) {
    return adapterFor(table && table.managedKind).sync.syncRows(table, opts);
}

/**
 * Refresh in the background if the copy is stale — false for an ordinary
 * table, so a read site can call it unconditionally behind its answer.
 */
function kickStale(table, opts) {
    const adapter = sourceOf(table);
    return adapter ? adapter.sync.kickStale(table, opts) : false;
}

/** The write-through module for a table's kind (insertRow/updateRow/deleteRow, the batch forms, contextOf). */
function writeThrough(table) {
    return adapterFor(table && table.managedKind).writeThrough;
}

/** The kind-specific fields of a `source` block's public projection (the envelope stays in the routes). */
function publicSourceExtras(source) {
    const adapter = source && isSourceKind(source.kind) ? KINDS[source.kind] : null;
    return adapter && typeof adapter.publicSource === 'function' ? (adapter.publicSource(source) || {}) : {};
}

/** 'Nextcloud' | 'the spreadsheet' — the word a sentence uses for where the rows live. */
function sourceLabel(tableOrKind) {
    const kind = typeof tableOrKind === 'string' ? tableOrKind : (tableOrKind && tableOrKind.managedKind);
    const spec = managedKindSpec(kind);
    return (spec && spec.sourceLabel) || 'the source';
}

/** The badge the App Studio builder shows on a linked table: 'nextcloud' | 'spreadsheet' | 'studio'. */
function builderKindOf(kind) {
    const spec = managedKindSpec(kind);
    return (spec && spec.builderKind) || 'studio';
}

module.exports = {
    KINDS,
    SOURCE_KINDS,
    isSourceKind,
    adapterFor,
    sourceOf,
    isSourceMirror,
    syncRows,
    kickStale,
    writeThrough,
    publicSourceExtras,
    sourceLabel,
    builderKindOf,
};
