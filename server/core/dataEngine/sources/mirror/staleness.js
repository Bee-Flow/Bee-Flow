// @typecheck strict
/**
 * When does a mirror need another look, and who gives it one?
 *
 * ── ONE SCHEDULE: LIVE ──────────────────────────────────────────────
 * A mirror is a source seen from Bee Flow, and a person looking at it expects
 * what the source has, not what it had a quarter of an hour ago — so there
 * is no cadence to choose. Three mechanisms make it so, and all three are
 * always on: the client pulses while the table is open (a re-check every few
 * seconds, see LIVE_STALE_MS), the ticker re-checks every minute in the
 * background, and the source's push events land whenever it delivers them.
 * Kept as a function, and as a stored `{ everyMinutes, live }` block, so a
 * cadence could be reintroduced without touching the callers.
 *
 * ── ONE KICK MAP ────────────────────────────────────────────────────
 * `makeKickStale` builds the background-refresh trigger for one adapter, but
 * every kind shares the `_kicks` map: a mirror has one id whatever its kind,
 * and one pending refresh is the debounce's whole point.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const { nextRunFor } = require('../../../scheduling/nextRun');
const { DEFAULT_MINUTES, MIN_MIRROR_MINUTES, LIVE_STALE_MS, KICK_DEBOUNCE_MS } = require('./constants');
const log = require('../../../../telemetry/log');

/** @type {(source?: object) => { everyMinutes: number, live: boolean }} */
function scheduleOf() {
    return { everyMinutes: MIN_MIRROR_MINUTES, live: true };
}

/**
 * When the ticker should look again — null for a schedule of "never".
 * @param {{ everyMinutes?: number, live?: boolean } | null | undefined} schedule
 * @param {number} fromTs
 * @param {number} consecutiveErrors
 */
function nextRunAtFor(schedule, fromTs, consecutiveErrors) {
    const { everyMinutes: every } = scheduleOf({ schedule });
    if (every === 0 && !consecutiveErrors) return null;
    return nextRunFor(
        { everyMinutes: every > 0 ? every : DEFAULT_MINUTES },
        fromTs,
        { consecutiveErrors, defaultMinutes: DEFAULT_MINUTES, floorMinutes: MIN_MIRROR_MINUTES },
    );
}

/**
 * Should a look at this mirror trigger a re-check? Not while one runs; not
 * when the owner switched refresh-on-open off; yes when it was never
 * refreshed, when something marked it stale, or when the last successful
 * pass is older than LIVE_STALE_MS.
 *
 * @param {{ status?: string, lastSuccessAt?: string, staleReason?: string }} [syncState]
 * @param {{ refreshOnView?: boolean }} [source]
 * @param {number} [now]
 */
function isStale(syncState, source, now = Date.now()) {
    if (source && source.refreshOnView === false) return false;
    const s = syncState || {};
    if (s.status === 'running') return false;
    if (!s.lastSuccessAt) return true;
    if (s.staleReason) return true;
    const last = Date.parse(s.lastSuccessAt);
    if (!Number.isFinite(last)) return true;
    const { everyMinutes: every, live } = scheduleOf(source);
    if (live) return now - last >= LIVE_STALE_MS;
    const minutes = every > 0 ? every : DEFAULT_MINUTES;
    return now - last >= minutes * 60_000;
}

const _kicks = new Map();

/**
 * Build `kickStale(datatable, { reason, delayMs })` for one adapter: refresh
 * in the background if the copy is stale. Fire-and-forget and fully guarded:
 * the response that prompted it has already gone out, and a failure here
 * lands on the sync state for the owner to see.
 *
 * @param {{ syncRows: (table:object, opts:object) => Promise<unknown>, isMirror: (table:object) => boolean,
 *   TAG: string }} deps `isMirror`: "is this one of mine?"; `TAG`: log prefix
 * @returns {(datatable:{ id:string, scope?:{kind:'org'|'user',id:string}, syncState?:object, source?:object }, opts?:{reason?:string, delayMs?:number}) => boolean}
 *   whether a refresh was scheduled
 */
function makeKickStale({ syncRows, isMirror, TAG }) {
    return function kickStale(datatable, { reason = 'view', delayMs = KICK_DEBOUNCE_MS } = {}) {
        if (!datatable || !isMirror(datatable)) return false;
        if (!isStale(datatable.syncState, datatable.source)) return false;
        if (_kicks.has(datatable.id)) return true;
        const timer = setTimeout(() => {
            _kicks.delete(datatable.id);
            Promise.resolve()
                .then(() => (datatable.scope ? datatableStore.getDatatable(datatable.id, datatable.scope) : null))
                .then(fresh => (fresh && isStale(fresh.syncState, fresh.source) ? syncRows(fresh, { reason }) : null))
                .catch(e => log.warn(`${TAG} background refresh of ${datatable.id} failed: ${e && e.message}`));
        }, delayMs);
        timer.unref?.();
        _kicks.set(datatable.id, timer);
        return true;
    };
}

module.exports = { scheduleOf, nextRunAtFor, isStale, makeKickStale, _kicks };
