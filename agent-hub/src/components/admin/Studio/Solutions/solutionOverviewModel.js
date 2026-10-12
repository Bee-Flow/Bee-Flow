import { COUNTED_SECTIONS } from './solutionCounts';

/**
 * What one Solutions-overview card actually says, decided in one place.
 *
 * GET /api/projects/summary answers with a row per Solution in which every
 * tally can be `null`, and its module header spells out why: on this screen a
 * Solution looks fine, so a number nobody could read must not render as a 0 and
 * an unrun check must not render as a green tick. That rule is only worth
 * anything if the code that turns those rows into chips honours it, which is
 * what this module is — and being pure, it is where the rule can be tested
 * without a browser.
 *
 * ── No English leaves this module ──────────────────────────────────────────
 *
 * Every function below returns a STATE, never a sentence. The card renders the
 * state through `t()`. A helper that returned prose would put copy in a place
 * no translator can reach — the same contract installRequirements.js keeps.
 *
 * ── The two tabs cover every row ───────────────────────────────────────────
 *
 * "From us" and "Installed" partition the list on ONE fact: whether the
 * Solution came out of a Blueprint. Not on ownership, which is what the brief
 * says and what the first draft did — a Solution somebody shared with you is
 * neither yours nor installed, so it appeared under no tab at all and simply
 * vanished from the screen. A row the server returned and the screen drops is
 * the overview's own version of an empty list that should have been an error.
 * Ownership is still on the card, as the role it always was.
 */

/** Which of the two project tabs a row belongs to. Total by construction. */
export function tabOf(row) {
    return row?.installedFromBlueprintId ? 'installed' : 'ours';
}

/** The rows, split over the two project tabs. Every row lands in exactly one. */
export function partitionSolutions(rows) {
    const ours = [];
    const installed = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row.id !== 'string') continue;
        (tabOf(row) === 'installed' ? installed : ours).push(row);
    }
    return { ours, installed };
}

/**
 * The health chip.
 *
 *   unknown   nobody checked this Solution — NOT "nothing wrong"
 *   unread    the checks ran over a Solution that could not be fully read
 *   blocking  n findings that have to be fixed
 *   advice    n findings worth a look
 *   clear     the server said the picture was whole and held nothing
 *
 * `unread` deliberately outranks `blocking`, and that ordering is the whole
 * point of the state. A count derived from a partial read is misleading
 * precision: "2 to fix" over a Solution whose apps could not be listed reads as
 * a complete answer, and the reader has no way to know there might be five. So
 * the card says the picture is incomplete and withholds the number; the Check
 * tab, which can show what was and was not read, is where the findings live.
 *
 * `clear` is reachable only from `complete === true` with nothing found — the
 * same single path to a reassuring sentence SolutionControlPanel keeps.
 */
export function healthOf(row) {
    const c = row?.completeness;
    if (!c) return { state: 'unknown', count: 0 };
    if (c.complete !== true) return { state: 'unread', count: 0 };
    if (c.errors > 0) return { state: 'blocking', count: c.errors };
    if (c.warnings > 0) return { state: 'advice', count: c.warnings };
    if (c.findings > 0) return { state: 'advice', count: c.findings };
    return { state: 'clear', count: 0 };
}

/**
 * The run line.
 *
 *   unknown  the run tally could not be read — NOT "nothing ran"
 *   failed   something ran and something failed
 *   ran      something ran, nothing failed
 *   idle     the tally was read and it is zero
 *
 * `idle` renders a sentence rather than nothing, because "no line" is what
 * `unknown` would look like if it rendered nothing too, and those two must
 * never look the same.
 */
export function runsOf(row) {
    const runs = row?.runs;
    if (!runs || typeof runs !== 'object') return { state: 'unknown', today: null, failed: null };
    // Number(null) is 0, so a per-field "I could not count" would read as a
    // quiet day. Both halves have to BE numbers, not merely coerce to one.
    const today = typeof runs.today === 'number' ? runs.today : NaN;
    const failed = typeof runs.failed === 'number' ? runs.failed : NaN;
    if (!Number.isFinite(today) || !Number.isFinite(failed)) {
        return { state: 'unknown', today: null, failed: null };
    }
    if (failed > 0) return { state: 'failed', today, failed };
    if (today > 0) return { state: 'ran', today, failed };
    return { state: 'idle', today, failed };
}

/**
 * The chip row: one chip per kind this Solution holds, plus the kinds whose
 * count could not be read.
 *
 * A `null` count is NOT a chip and NOT a zero. It goes on `unreadable`, which
 * the card prints as a named gap — the section keys travel as machine keys and
 * solutionNotices.sectionNames is where they become words. A count of 0 gets no
 * chip either, but for the opposite reason: the server answered, and "no apps"
 * is not worth a chip on a card. The two are told apart by which list they land
 * in, never by their absence.
 */
export function chipsOf(row) {
    const counts = row?.counts || {};
    const chips = [];
    const unreadable = [];
    for (const { section, kind } of COUNTED_SECTIONS) {
        const n = counts[section];
        if (n === null || n === undefined) { unreadable.push(section); continue; }
        const value = Number(n);
        if (!Number.isFinite(value)) { unreadable.push(section); continue; }
        if (value > 0) chips.push({ section, kind, count: value });
    }
    return { chips, unreadable };
}

/**
 * Whether a newer Blueprint exists — for a Solution that came from one.
 *
 *   null       not installed from a Blueprint; there is no question to answer
 *   unknown    installed, but we cannot tell (the Blueprint is gone, belongs to
 *              an organisation this reader is not in, or no version was
 *              recorded). NOT "up to date"
 *   available  there is a newer version, and `latestVersion` names it
 *   current    the server compared the two and said no
 *
 * What is NEW in that version is O4's question, not this screen's.
 */
export function updateOf(row) {
    const update = row?.update;
    if (!update) return null;
    const installedVersion = Number.isFinite(update.installedVersion) ? update.installedVersion : null;
    if (update.available === true) {
        return {
            state: 'available',
            installedVersion,
            latestVersion: Number.isFinite(update.latestVersion) ? update.latestVersion : null,
        };
    }
    if (update.available === false) return { state: 'current', installedVersion, latestVersion: update.latestVersion ?? null };
    return { state: 'unknown', installedVersion, latestVersion: null };
}

/**
 * Read the summary payload.
 *
 * Defensive on purpose: this runs on a body that arrived over the wire, and the
 * one shape it must never invent is an empty, complete-looking overview. A body
 * without a `projects` array is `rows: []` WITH `unavailable: ['all']` — the
 * same marker the route's own 500 path carries — so a caller cannot render it
 * as "you have no Solutions".
 */
export function readSummary(body) {
    const rows = Array.isArray(body?.projects) ? body.projects.filter(r => r && typeof r.id === 'string') : null;
    const declared = Array.isArray(body?.unavailable) ? body.unavailable.filter(k => typeof k === 'string' && k) : [];
    return {
        rows: rows || [],
        unavailable: rows ? declared : Array.from(new Set([...declared, 'all'])),
        hasMore: body?.hasMore === true,
        checkedCount: Number.isFinite(body?.checkedCount) ? body.checkedCount : null,
    };
}

/**
 * Whether a card asks for a look: something to fix or unreadable, a failed run
 * today, or a stage whose last deployment failed or is waiting. An update
 * available is news, not attention. Unknown ("not checked") does NOT count as
 * attention either, but it also never counts as fine: it sorts with the rest.
 */
export function needsAttention(row) {
    const health = healthOf(row).state;
    if (health === 'blocking' || health === 'unread' || health === 'advice') return true;
    if (runsOf(row).state === 'failed') return true;
    const stages = Array.isArray(row?.stages) ? row.stages : [];
    return stages.some(s => s && (s.lastDeploymentStatus === 'failed'
        || s.lastDeploymentStatus === 'awaiting_approval'
        || s.lastDeploymentStatus === 'succeeded_with_warnings'
        || s.pending));
}

/**
 * Search + scope for the overview toolbar. scope: 'all' | 'mine' | 'attention'.
 * `mine` is the Solutions the reader owns. The server's order is kept inside
 * each group; cards that need attention come first (stable).
 */
export function filterSolutions(rows, { query = '', scope = 'all' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const kept = (rows || []).filter(row => {
        if (scope === 'mine' && row.permission !== 'owner') return false;
        if (scope === 'attention' && !needsAttention(row)) return false;
        if (!q) return true;
        return `${row.name || ''} ${row.description || ''}`.toLowerCase().includes(q);
    });
    return [...kept.filter(needsAttention), ...kept.filter(r => !needsAttention(r))];
}
