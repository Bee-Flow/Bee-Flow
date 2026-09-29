/**
 * Thin client over /api/cowork for the Work surface.
 *
 * Cowork items are the schedules the Chat ⇄ Cowork switch produces: their own
 * rows, their own runner tick, and — unlike the prompt tasks this used to sit
 * on — a history row per execution, which is what the Studio Cowork tab reads.
 *
 * The `{ items, maxItems }` shape is kept for callers; only the transport
 * moved.
 */
import { API_BASE, authFetch } from '../../utils/helpers';

const BASE = () => `${API_BASE}/api/cowork`;

/**
 * URL for one item, with an optional sub-path (`/toggle`, `/runs`).
 *
 * The id is escaped here, at the single place these URLs are built, so it can
 * only ever be one path segment: a `../` cannot climb out of /api/cowork and a
 * `?` cannot graft a query string onto the request. Ids happen to come from our
 * own list response today, but the guard belongs to the URL, not to today's
 * caller.
 */
const itemUrl = (id, suffix = '') => `${BASE()}/${encodeURIComponent(id)}${suffix}`;

async function readError(res, fallback) {
    const body = await res.json().catch(() => ({}));
    return new Error(body.error || fallback);
}

export async function listCowork() {
    const res = await authFetch(BASE());
    if (!res.ok) throw await readError(res, 'Could not load your work');
    const data = await res.json();
    return { items: data.schedules || [], maxItems: data.maxSchedules || 10 };
}

export async function createCowork(payload) {
    const res = await authFetch(BASE(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw await readError(res, 'Could not create this work');
    return res.json();
}

export async function updateCowork(id, payload) {
    const res = await authFetch(itemUrl(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw await readError(res, 'Could not save this work');
    return res.json();
}

export async function toggleCowork(id) {
    const res = await authFetch(itemUrl(id, '/toggle'), { method: 'POST' });
    if (!res.ok) throw await readError(res, 'Could not pause/resume this work');
    return res.json();
}

export async function runCoworkNow(id) {
    const res = await authFetch(itemUrl(id, '/run-now'), { method: 'POST' });
    if (!res.ok) throw await readError(res, 'Could not start this work');
    return res.json();
}

export async function deleteCowork(id) {
    const res = await authFetch(itemUrl(id), { method: 'DELETE' });
    if (!res.ok) throw await readError(res, 'Could not delete this work');
    return res.json();
}

/**
 * Ask the server to turn a spoken-language brief into a cowork spec.
 * Creates nothing — the caller decides what to do with the answer.
 */
export async function composeCowork(brief, { timezone } = {}) {
    const res = await authFetch(`${BASE()}/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            brief,
            timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
    });
    if (!res.ok) throw await readError(res, 'Could not work out what to schedule');
    return res.json();
}

/** Execution history for one schedule, newest first. */
export async function listCoworkRuns(id, { limit = 25, offset = 0 } = {}) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const res = await authFetch(itemUrl(id, `/runs?${qs}`));
    if (!res.ok) throw await readError(res, 'Could not load the run history');
    const data = await res.json();
    return { runs: data.runs || [], total: data.total || 0 };
}

/**
 * De cijfers achter één opdracht (CW-11): hoeveel keer gedraaid, hoeveel
 * daarvan geslaagd, hoe lang een keer gemiddeld duurt.
 *
 * `total` telt de BEWAARDE historie (de retentiesweep ruimt na 90 dagen op);
 * `runCount` is de levenslange teller van het schema zelf en is wat "42 keer
 * gedraaid" hoort te zeggen. Ze lopen met opzet uiteen — verwar ze niet.
 *
 * Er zit geen kosten- of tokenveld in: het runpad legt geen usage vast
 * (CW-12), en een ontbrekend veld dat als "€ 0,00" rendert is erger dan een
 * kaart die er niet staat. `avgDurationMs` blijft null als er nog nooit een
 * poging is afgerond — dat is iets anders dan nul milliseconden.
 */
export async function getCoworkStats(id) {
    const res = await authFetch(itemUrl(id, '/stats'));
    if (!res.ok) throw await readError(res, 'Could not load the figures for this work');
    const data = await res.json();
    return {
        total: data.total || 0,
        success: data.success || 0,
        failed: data.failed || 0,
        avgDurationMs: data.avgDurationMs ?? null,
        runCount: data.runCount || 0,
        createdAt: data.createdAt || null,
    };
}

/** Agents the user can hand work to. Empty list when the beta is off. */
export async function listCoworkAgents() {
    const res = await authFetch(`${API_BASE}/agents/all`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data) ? data : (data.agents || []);
}
