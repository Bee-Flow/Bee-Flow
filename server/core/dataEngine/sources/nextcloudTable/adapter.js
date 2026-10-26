// @typecheck noImplicitAny
/**
 * The Nextcloud Tables ADAPTER CORE: the members the sync and write-through
 * pipelines drive. The adapter the registry hands out is kindAdapter.js, this plus
 * the `sync`, `writeThrough`, `link` and `events` modules; they sit on the other
 * side of this file so that none of them has to require the adapter back
 * (import cycle).
 *
 * The Nextcloud Tables ADAPTER — what the shared mirror engine (../mirror)
 * asks a source kind, answered in Nextcloud's terms.
 *
 * The registry (../index.js) hands this object to routes, jobs and runners;
 * sync.js and writeThrough.js are `makeSync(adapter)` / `makeWriteThrough(…)`
 * over it. Every member that reaches a module with side effects is a LAZY
 * getter or a call-time require, for two reasons that both matter:
 *   • requiring the registry must load nothing of a kind nobody asked for;
 *   • the engine unit tests stub `./linkerAuth`, `./ncApi`, `./sync` and
 *     `./relations` by request string and swap members on the stub at call
 *     time (sync.test.js replaces ncApi.forLinker mid-suite), so the adapter
 *     reads them when it needs them, never once at load.
 *
 * A Nextcloud table has no cheap "did anything move?" probe — its rows are
 * paged from the API either way — so `open()` never answers `unchanged`.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const { KIND, isMirror } = require('./index');
const { fieldsFromNcColumns } = require('./columns');
const { mirrorRowFromNc } = require('./rows');
const { isSourceError } = require('../mirror/errors');

const TAG = '[NextcloudTable]';

/** @typedef {{ ncTableId?: number, ncViewId?: number, ncTitle?: string, ncEmoji?: string, ncBaseUrl?: string, refreshOnView?: boolean }} NcSource */
/** @typedef {import('./columns').NcColumn} NcColumn */
/** @typedef {Parameters<typeof fieldsFromNcColumns>[1]} DeriveCtx */

/** @param {NcSource} source */
function refOf(source) {
    return source.ncViewId ? { viewId: source.ncViewId, tableId: source.ncTableId } : { tableId: source.ncTableId };
}

/**
 * Everything the columns derivation needs to know about the other mirrors in this scope.
 * @param {{ kind: string, id: string }} scope
 */
async function siblingsOf(scope) {
    // Every mirror in the scope, whatever its kind: a match relation may
    // point at a spreadsheet mirror. The Nextcloud-native maps are built
    // over this kind only — a sheet has no ncTableId.
    const mirrors = await datatableStore.listSourceMirrorsInScope(scope);
    const linkedTargets = new Map();
    const linkedViews = new Map();
    const byId = new Map();
    for (const m of mirrors) {
        byId.set(m.id, m);
        if (m.managedKind !== KIND) continue;
        const src = m.source || {};
        if (src.ncViewId) linkedViews.set(Number(src.ncViewId), m.id);
        else if (src.ncTableId) linkedTargets.set(Number(src.ncTableId), m.id);
    }
    return { linkedTargets, linkedViews, byId };
}

const adapter = {
    KIND,
    TAG,
    label: 'Nextcloud',
    builderKind: 'nextcloud',
    isMirror,
    get PAGE() { return require('./ncApi').PAGE || 500; },
    get errors() {
        const own = require('./errors');
        return { ...own, isSourceError, Err: own.NextcloudSourceError };
    },

    /**
     * @param {{ linkedByUserId?: string; ncTableId?: number; ncInstanceId?: string; }} source
     * @param {{ orgId?: string | null; fresh?: boolean; } | undefined} opts
     */
    resolveLinker(source, opts) {
        return require('./linkerAuth').resolveLinker(source, opts);
    },
    /** @param {Parameters<typeof import('./ncApi').forLinker>[0]} auth */
    apiFor(auth) {
        return require('./ncApi').forLinker(auth);
    },
    siblingsOf,

    /**
     * Columns now; rows page by page when the pipeline asks.
     * @param {ReturnType<typeof import('./ncApi').forLinker>} api
     * @param {{ source: NcSource }} table
     */
    async open(api, table) {
        const ref = refOf(table.source);
        const columns = await api.getColumns(ref);
        return {
            columns,
            page: (/** @type {number} */ limit, /** @type {number} */ offset) => api.listRows(ref, { limit, offset }),
        };
    },

    /**
     * @param {NcColumn[]} columns
     * @param {{ existingFields?: DeriveCtx['existingFields'], siblings: { linkedTargets: Map<number, string>, linkedViews: Map<number, string> }, declaredRelations?: DeriveCtx['declaredRelations'] }} opts
     */
    deriveFields(columns, { existingFields, siblings, declaredRelations }) {
        return fieldsFromNcColumns(columns, {
            existingFields,
            linkedTargets: siblings.linkedTargets,
            linkedViews: siblings.linkedViews,
            declaredRelations,
        });
    },

    /**
     * A row without an id cannot be a mirror row (null = skipped).
     * @param {Parameters<typeof mirrorRowFromNc>[0] | null | undefined} raw
     * @param {Parameters<typeof mirrorRowFromNc>[1]} ctx
     */
    rowFromSource(raw, ctx) {
        if (!raw || raw.id === undefined || raw.id === null) return null;
        return mirrorRowFromNc(raw, ctx);
    },

    /**
     * @param {Parameters<typeof import('./relations').labelFieldFor>[0]} rel
     * @param {Parameters<typeof import('./relations').labelFieldFor>[1]} target
     */
    labelFieldFor(rel, target) {
        return require('./relations').labelFieldFor(rel, target);
    },

    /**
     * The kind-specific half of the public projection (routes keep the envelope).
     * @param {NcSource} source
     */
    publicSource(source) {
        return {
            ncTableId: source.ncTableId,
            ncViewId: source.ncViewId || null,
            ncTitle: source.ncTitle || null,
            ncEmoji: source.ncEmoji || null,
            // The table (or view) in Nextcloud's own Tables app. Relative when the
            // org's base URL is unknown — inside the ExApp frame that still lands.
            ncUrl: `${String(source.ncBaseUrl || '').replace(/\/+$/, '')}/apps/tables/#/${source.ncViewId ? `view/${source.ncViewId}` : `table/${source.ncTableId}`}`,
        };
    },
};

module.exports = adapter;
