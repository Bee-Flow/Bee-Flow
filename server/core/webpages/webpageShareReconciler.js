// @typecheck
/**
 * When a public snapshot must be rewritten.
 *
 * A public share is not a live page but a FROZEN, script-free,
 * DOMPurify-cleaned snapshot (services/webpageSnapshot.js). On /w/<slug> no `beeflowTables` runs; the table rows that stand there
 * were rendered server-side from `publicColumns` at the moment the snapshot
 * was written. That is precisely what makes a public page safe — and precisely
 * why it does not update itself.
 *
 * ── WHY THIS IS A GDPR PATH, NOT A REFRESH BUTTON ───────────────────
 *
 * Until now a snapshot was only rewritten when the OWNER saved the page
 * (routes/webpages.js). For the bytes of the page that is right. For the
 * ROWS that are baked into it it is not:
 *
 *   - the retention sweep removes a row that is too old;
 *   - someone exercises his right to erasure (DSR) and his row goes away;
 *   - an automation deletes a row.
 *
 * In all three cases the row has disappeared from the table and still stands on the
 * public page, for everyone with the address, until the owner happens to save something. A deleted row that stays on a public snapshot is not a stale
 * cache but a deletion that has not taken place. That is why this module hangs on the same tap as the live
 * knowledge sources (K8): `datatableStore.notifyDatatableChanged` — one
 * debounced notification per table, after every write path that exists, the
 * retention sweep included.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────
 *
 * No guarantee and no synchronicity. The tap is an in-process timer: it does not survive a
 * restart and does not cross a replica. So there stands "within the sync latency", not "immediately", and whoever needs hard deletion
 * withdraws the share — that is the only thing that works directly. What this module
 * removes, it removes best-effort; what it does not reach stays until the
 * next occasion. A backstop such as `armStaleLiveSources` that exists for the
 * knowledge sources is not built here yet (see openPunten).
 *
 * ── FAILS CLOSED, NOT OPEN ──────────────────────────────────────────
 *
 * If the list of bound pages cannot be read, then NOTHING is rewritten and that is
 * written to the log. There is no branch that in case of doubt does "then just everything" or "then nothing, silently":
 * an unreadable list is a known-unknown and must be loud.
 */

'use strict';

const { featureModule } = require('../featureModules');
const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * Rewrite every live public snapshot of ONE page.
 *
 * Moved out of routes/webpages.js so that there is one implementation: the route
 * calls it on an owner save, this module on a table mutation. Two copies would mean that
 * one skips the withdrawn shares and the other does not.
 *
 * Awaitable, but the callers in the routes use it fire-and-forget:
 * a save may never wait on a snapshot.
 * @param {string} webpageId
 * @param {string} ownerId
 */
async function reSnapshotWebpageShares(webpageId, ownerId, deps = {}) {
    const publicShareStore = deps.publicShareStore || require('../../stores/webpagePublicShareStore');
    const webpageSnapshot = deps.webpageSnapshot || featureModule('services/webpageSnapshot');
    const log = deps.log || console;
    let written = 0;
    try {
        const shares = await publicShareStore.listSharesForWebpage(webpageId, ownerId);
        for (const sh of (shares || [])) {
            if (sh.revokedAt) continue;
            try {
                await webpageSnapshot.writeSnapshot({ shareId: sh.id, webpageId, ownerId });
                written += 1;
            } catch (e) {
                log.warn(`[Webpages] re-snapshot failed for share ${sh.id}: ${/** @type {Error} */ (e).message}`);
            }
        }
    } catch (e) {
        log.warn(`[Webpages] re-snapshot enumeration failed: ${/** @type {Error} */ (e).message}`);
    }
    return written;
}

/**
 * Fire-and-forget-variant voor de routes: nooit awaiten, nooit gooien.
 * @param {string} webpageId
 * @param {string} ownerId
 */
function reSnapshotWebpageSharesDetached(webpageId, ownerId, deps = {}) {
    Promise.resolve()
        .then(() => reSnapshotWebpageShares(webpageId, ownerId, deps))
        .catch((e) => bestEffort('core/webpages/webpageShareReconciler:reSnapshotWebpageSharesDetached', e));
}

/**
 * The rows of this table have changed — refresh every public page that
 * hangs on it.
 *
 * Called from `datatableStore.notifyDatatableChanged`, the same debounced
 * tap that arms the live knowledge sources. Best-effort and without
 * ever throwing: it hangs behind a write action that has already been committed.
 *
 * @returns the number of pages for which something has been rewritten
 */
async function onDatatableChanged(datatableId, deps = {}) {
    if (!datatableId) return 0;
    const grants = deps.bridgeGrants || bridgeGrants;
    const log = deps.log || console;
    let bound;
    try {
        bound = await grants.listPublicWebpagesBoundToDatatable(datatableId);
    } catch (e) {
        // Unknown narrows: rewrite nothing, and say so loudly. Silently
        // continuing would mean that a deleted row stays standing without
        // any trace of it anywhere.
        log.warn(`[Webpages] could not list pages bound to datatable ${datatableId}: ${/** @type {Error} */ (e).message}`);
        return 0;
    }
    if (!bound || bound.length === 0) return 0;
    let pages = 0;
    for (const page of bound) {
        const written = await reSnapshotWebpageShares(page.webpageId, page.ownerId, deps);
        if (written > 0) pages += 1;
    }
    if (pages > 0) {
        log.log(`[Webpages] datatable ${datatableId} changed — re-snapshotted ${pages} public page(s)`);
    }
    return pages;
}

module.exports = {
    reSnapshotWebpageShares,
    reSnapshotWebpageSharesDetached,
    onDatatableChanged,
};

/**
 * Injecteerbare afhankelijkheden (tests geven nepversies mee).
 * @typedef {{
 *   publicShareStore?: Pick<typeof import('../../stores/webpagePublicShareStore'), 'listSharesForWebpage'>,
 *   webpageSnapshot?: Pick<typeof import('../../services/webpageSnapshot'), 'writeSnapshot'>,
 *   bridgeGrants?: Pick<typeof bridgeGrants, 'listPublicWebpagesBoundToDatatable'>,
 *   log?: Pick<Console, 'warn' | 'log'>,
 * }} ReconcilerDeps
 */
