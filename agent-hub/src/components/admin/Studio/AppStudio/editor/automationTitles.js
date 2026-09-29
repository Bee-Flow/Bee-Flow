import { useEffect, useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';

/**
 * Automation id → title, for the canvas pill (Studio artboard 1b: "start
 * automation · Offerte berekenen").
 *
 * A run_automation action stores only `automationId`; the title lives on the
 * automation row. The inspector's ActionsSection already fetches the list for
 * its own labels, but the CANVAS needs the same one word next to a selected
 * button — and every selected node asking for it separately would be one
 * request per selection.
 *
 * So: ONE request per browser session (60s TTL), shared by every caller
 * through a module-scope cache, and only ever fired by a caller that has
 * something to name (`useAutomationTitles(enabled)` with `enabled` false does
 * nothing at all). A failure resolves to an EMPTY map rather than rejecting —
 * a pill without a name still tells the truth ("start automation"), and a
 * label is never worth an error dialog.
 */

const TTL_MS = 60_000;

/** { at, rows } — the last successful load, id → the whole automation row. */
let cache = null;
/** The in-flight promise, so N simultaneous callers make ONE request. */
let inflight = null;

/** The cached row map when it is still fresh, else null. */
function freshRows() {
    return cache && Date.now() - cache.at < TTL_MS ? cache.rows : null;
}

/** id → title, derived. The rows are the cache; titles are a view of it. */
function titlesOf(rows) {
    const titles = {};
    for (const [id, row] of Object.entries(rows || {})) {
        if (row?.title) titles[id] = row.title;
    }
    return titles;
}

/** The cached titles when the load is still fresh, else null. */
function fresh() {
    const rows = freshRows();
    return rows ? titlesOf(rows) : null;
}

/**
 * Resolve the id→title map, from cache when fresh. Never rejects.
 * Exported for tests and for any caller that wants it outside React.
 */
export function loadAutomationRows(api) {
    const hit = freshRows();
    if (hit) return Promise.resolve(hit);
    if (inflight) return inflight;
    inflight = Promise.resolve()
        .then(() => api.listAutomations())
        .then((res) => {
            const rows = {};
            for (const row of res?.automations || []) {
                if (row?.id) rows[row.id] = row;
            }
            cache = { at: Date.now(), rows };
            return rows;
        })
        .catch(() => ({}))
        .finally(() => { inflight = null; });
    return inflight;
}

/** id → title. A thin view over loadAutomationRows — still ONE request. */
export function loadAutomationTitles(api) {
    return loadAutomationRows(api).then(titlesOf);
}

/** Drop the cache — for tests, and for a caller that just renamed a routine. */
export function clearAutomationTitles() {
    cache = null;
    inflight = null;
}

/**
 * `enabled` false → no request, no state, `null`. True → the map, from the
 * shared cache when it is warm (so the pill has its name on the very first
 * render after the first fetch of the session).
 */
export default function useAutomationTitles(enabled) {
    const api = useAutomationApi();
    const [titles, setTitles] = useState(fresh);
    useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        loadAutomationTitles(api).then((map) => { if (alive) setTitles(map); });
        return () => { alive = false; };
    }, [enabled, api]);
    return titles;
}

/**
 * The WHOLE rows, same cache, same single request.
 *
 * The canvas pill needs one word; the inspector's routine tile needs the step
 * count (from `definition`) and which solution the routine is filed in (from
 * `projectId`). Those live on the row the list endpoint already returns — the
 * cache used to throw them away, so the tile would have had to fetch the same
 * list a second time to read fields that were in the first response.
 *
 * Failure resolves to an EMPTY map, never a rejection: a tile that cannot name
 * the routine still shows the routine, and no part of an inspector is worth an
 * error dialog.
 */
export function useAutomationRows(enabled) {
    const api = useAutomationApi();
    const [rows, setRows] = useState(freshRows);
    useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        loadAutomationRows(api).then((map) => { if (alive) setRows(map); });
        return () => { alive = false; };
    }, [enabled, api]);
    return rows;
}
