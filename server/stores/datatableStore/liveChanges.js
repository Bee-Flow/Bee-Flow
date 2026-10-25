// @typecheck noImplicitAny
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
 * @param {string} datatableId
 */
async function getDataVersion(datatableId) {
    await initDB();
    if (!datatableId) return null;
    const r = await getOne(`SELECT data_version FROM datatables WHERE id = $1`, [datatableId]);
    return r ? Number(r.data_version) || 0 : null;
}

const LIVE_DEBOUNCE_MS = 5000;
const _liveTimers = new Map();

// Consumers register themselves at boot (jobs/datatableChangePorts.js, loaded by
// boot/featureRegistrations.js), so the storage layer never requires a feature.
/** @type {{ listener: (datatableId: string) => unknown, label: string }[]} */
const _listeners = [];
let _warnedNoListener = false;

/**
 * Register a consumer of "this table's rows moved". `listener(datatableId)` may
 * be async; each one is caught separately, so a failing consumer never stops
 * the others.
 * @param {(datatableId: string) => unknown} listener
 * @param {string} [label]
 */
function onDatatableChanged(listener, label = 'listener') {
    _listeners.push({ listener, label });
}

/** The labels of the registered consumers (for the boot wiring test). */
function liveListenerLabels() {
    return _listeners.map(l => l.label);
}

/**
 * @param {string} datatableId
 * @param {{ delayMs?: number, arm?: ((datatableId: string) => unknown) | null, reSnapshot?: ((datatableId: string) => unknown) | null }} opts
 */
function notifyDatatableChanged(datatableId, { delayMs = LIVE_DEBOUNCE_MS, arm = null, reSnapshot = null } = {}) {
    if (!datatableId) return;
    if (_liveTimers.has(datatableId)) return;   // already pending: one pass covers the burst
    const timer = setTimeout(() => {
        _liveTimers.delete(datatableId);
        // Tests inject arm / reSnapshot; they replace the registered consumers.
        const injected = [arm, reSnapshot].filter(Boolean).map(listener => ({ listener, label: 'injected' }));
        const targets = injected.length ? injected : _listeners;
        if (!targets.length && !_warnedNoListener) {
            _warnedNoListener = true;
            log.warn('[Datatables] a table changed but no live-change listener is registered (load jobs/datatableChangePorts.js); knowledge sources and shared pages will not refresh');
        }
        // Caught separately on purpose: if one falls over the other must still
        // run (a deleted row has to leave the public page even when the
        // knowledge-source arm fails).
        for (const { listener, label } of targets) {
            Promise.resolve()
                .then(() => listener(datatableId))
                .catch(e => log.warn(`[Datatables] live change listener "${label}" failed:`, e.message));
        }
    }, delayMs);
    // A pending refresh must never hold the process open at shutdown.
    timer.unref?.();
    _liveTimers.set(datatableId, timer);
}

module.exports = {
    getDataVersion,
    notifyDatatableChanged,
    onDatatableChanged,
    liveListenerLabels,
};
