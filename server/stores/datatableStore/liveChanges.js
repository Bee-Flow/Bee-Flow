// @typecheck
'use strict';

/**
 * Telling the live consumers that a table's rows moved — and letting them ask
 * how far behind they are.
 *
 * Two listeners hang off one debounced tap: the knowledge-source refresh job
 * (a `live` source must stop answering from rows that are gone) and the public
 * webpage snapshot reconciler (a share bakes the rows in as static HTML). They
 * are caught separately on purpose — if one falls over the other must still
 * run. `getDataVersion` is the other half: the backstop's question, answered
 * with a monotonic counter and nothing else.
 */

const { getOne } = require('../../db');
const { initDB } = require('./schema');
const log = require('../../telemetry/log');

/**
 * Tell the knowledge-source refresh job that a table's rows moved (K8).
 *
 * ── DEBOUNCED, BECAUSE A WRITE STEP IS NOT A WRITE ──────────────────
 * An automation looping over 400 rows bumps the version 400 times in a few
 * seconds. Arming on each one would queue 400 refresh passes over a table that
 * settled once. So the first bump starts a timer and every bump inside it
 * resets nothing — the pass runs once, `DEBOUNCE_MS` after the first.
 *
 * ── AND IT ONLY ARMS ────────────────────────────────────────────────
 * `next_refresh_at = now()`, then the 60-second tick does the work under the
 * lock, the concurrency limit and the time budget it already has. Refreshing
 * inline would put an embedding pass inside a datatable write.
 *
 * Never throws and never awaited: the write it follows has already committed.
 */
/**
 * A table's current `data_version`, WITHOUT its scope.
 *
 * Every other read here is narrowed to `(scope_kind, scope_id)`, and that rule
 * is load-bearing — an unfiltered list would return every row in the
 * deployment. This one is deliberately not, and it is safe for one reason: it
 * returns a MONOTONIC COUNTER and nothing else. No name, no owner, no scope, no
 * data. Its caller is the refresh backstop, which holds a knowledge source's
 * own `datatableId` and needs to know whether the rows moved since it last
 * looked; making it resolve a scope first would mean handing it the table row,
 * which is exactly what should not travel.
 *
 * Null when the table is gone.
 */
async function getDataVersion(datatableId) {
    await initDB();
    if (!datatableId) return null;
    const r = await getOne(`SELECT data_version FROM datatables WHERE id = $1`, [datatableId]);
    return r ? Number(r.data_version) || 0 : null;
}

const LIVE_DEBOUNCE_MS = 5000;
const _liveTimers = new Map();

function notifyDatatableChanged(datatableId, { delayMs = LIVE_DEBOUNCE_MS, arm = null, reSnapshot = null } = {}) {
    if (!datatableId) return;
    if (_liveTimers.has(datatableId)) return;   // already pending — one pass covers the burst
    const timer = setTimeout(() => {
        _liveTimers.delete(datatableId);
        Promise.resolve()
            .then(() => (arm || require('../../jobs/kbSourceRefresh').onDatatableChanged)(datatableId))
            .catch(e => log.warn('[Datatables] could not arm live knowledge sources:', e.message));
        // Dezelfde melding, tweede luisteraar (W3 stap 4): een OPENBARE
        // webpagina bakt de rijen van deze tabel in haar snapshot, dus een
        // verwijderde rij staat daar nog tot die snapshot herschreven wordt.
        // Apart afgevangen van de kennisbron-arm hierboven: als de een valt,
        // moet de ander toch draaien — dit is het pad waarlangs een gewiste
        // rij ook publiek verdwijnt.
        Promise.resolve()
            .then(() => (reSnapshot || require('../../core/webpages/webpageShareReconciler').onDatatableChanged)(datatableId))
            .catch(e => log.warn('[Datatables] could not refresh public webpage snapshots:', e.message));
    }, delayMs);
    // A pending refresh must never hold the process open at shutdown.
    timer.unref?.();
    _liveTimers.set(datatableId, timer);
}

module.exports = {
    getDataVersion,
    notifyDatatableChanged,
};
