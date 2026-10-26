import { logger } from '@/utils/logger';
/**
 * A one-way signal: "the server just told us which published version it is
 * serving".
 *
 * Every data response carries `appVersion`. Threading that up through
 * react-query results, AppDataScope and the render props would touch the
 * hottest path in the runtime and change shapes a dozen tests pin — for a
 * value nothing in the render tree consumes. So the fetch layer simply
 * REPORTS it here, and the run page (the only interested party) subscribes.
 *
 * Deliberately not a store: no history, no state to get out of sync. The last
 * number the server said, plus a way to hear the next one.
 */

/** What the run page hears: the version the server just reported. */
type VersionListener = (version: number | string) => void;

const listeners = new Map<string, Set<VersionListener>>(); // appId → Set<fn>
const latest = new Map<string, number | string>();    // appId → last reported version

export function reportAppVersion(appId: string | null | undefined, version: number | string | null | undefined) {
    if (!appId || version === undefined || version === null) return;
    if (latest.get(appId) === version) return;
    latest.set(appId, version);
    for (const fn of (listeners.get(appId) || [])) {
        try { fn(version); } catch (err) { logger.debug('a listener must never break a fetch', err); }
    }
}

export function subscribeAppVersion(appId: string | null | undefined, fn: VersionListener) {
    if (!appId || typeof fn !== 'function') return () => {};
    let set = listeners.get(appId);
    if (!set) { set = new Set(); listeners.set(appId, set); }
    set.add(fn);
    return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(appId);
    };
}

/** Test seam — drops every listener and remembered version. */
export function _resetAppVersionSignal() {
    listeners.clear();
    latest.clear();
}
