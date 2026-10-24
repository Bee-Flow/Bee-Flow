import { API_BASE, authFetch } from '../../../../utils/helpers';
import {
    RECENT_STATUS, STUDIO_RECENT_SOURCES, normaliseRecentRows, recentStatusOf,
} from '../../../../utils/studioRecentSources';
import type { RecentStatusCode } from '../../../../utils/studioRecentSources';
import type { RecentPayload } from '../../../../utils/studioRecentSources.types';

/** The word, the ink and (for the two "no status" cases) the explanation of a status code. */
export interface StatusLabel {
    key: string;
    fallback: string;
    tone: string;
    hintKey?: string;
    hintFallback?: string;
}

/** A section as resolveStudioNav yields it; runtime modules also carry a `label()`. */
interface RecentSection {
    id?: string;
    kind?: string | null;
    urlSegment?: string;
    label?: unknown;
    locked?: string | null;
}

/** Een gevraagde sectie: waar ze staat en welk endpoint haar lijst geeft. */
interface RecentAsk {
    sectionId: string;
    kind: string | null;
    urlSegment: string;
    url: string;
}

/** Eén rij van de lijst, klaar om te tekenen. */
export interface RecentEntry {
    key: string;
    id: string;
    sectionId: string;
    kind: string | null;
    name: string | null;
    description: string | null;
    updatedAt: string | null;
    at: number | null;
    status: RecentStatusCode;
    path: string;
}

interface RecentSectionResult {
    sectionId: string;
    entries: RecentEntry[];
    refused: boolean;
    gap: boolean;
}

/** Het resultaat van de hele lijst; zie runRecentWork. */
export interface RecentWork {
    items: RecentEntry[];
    unavailable: string[];
    skipped: string[];
    unsupported: string[];
    complete: boolean;
}

/**
 * "Recently edited" on the Studio start screen — the MODEL (Track H3).
 *
 * One list across all sections, merged from the nine sources that
 * utils/studioRecentSources.js already describes. That register is NOT
 * overwritten here: the URL, the envelope unpacker, the field mapper and the
 * status reader all come from there. A second list of endpoints next to it is
 * precisely the variant that, after half a year, gives a different answer than
 * the flyout in the sidebar.
 *
 * ── The model comes from actionChecks/attentionChecks ───────────────────────
 *
 *   - NETWORK ONLY LIVES IN fetchSection; judging is a pure function on a
 *     plain object, exported separately and tested separately;
 *   - each section runs in its own catch: one list that falls over names its
 *     own gap and does not drag the list along;
 *   - the result carries THREE values, not two: found / nothing found /
 *     could not look (search.js's errors[], completeness.js's
 *     unavailable[]). `complete` is the only right to say "nothing edited yet".
 *
 * ── No permission guess in the client ───────────────────────────────────────
 *
 * There is deliberately NO permission gate per source in this file. /agents/all
 * requires manage_agents, but a client that judges that itself hides the
 * section early or late for someone who does have the right (RunsStudio keeps
 * the same rule: the server is the authority and refuses in words). So we ask,
 * and we READ the answer:
 *
 *   403            the server refuses → `skipped`. Not yours, so also no
 *                  gap: nothing was lost that you could have seen
 *   401 / 5xx /    we could not look → `unavailable`, and that shows on the
 *   unreadable     screen
 *
 * A section that already fails the gate of the Studio register (`locked`) is
 * not even asked for — it appears as a sign, not as a door.
 *
 * ── Why NOT rankStudioItems ─────────────────────────────────────────────────
 *
 * utils/studioRecents.js ranks first on "opened by you on this device" and only
 * then on updatedAt. That is the right answer to "what was I working on" in the
 * sidebar flyout, and the WRONG answer to a heading called "Recently edited": an
 * agent you only opened this morning would stand above a table that was really
 * written to today. This list therefore sorts on updatedAt, one meaning per
 * heading.
 *
 * ── What this costs ────────────────────────────────────────────────────────
 *
 * At most nine requests, ONCE, when Start is opened — no timer. The rail already
 * polls the counts every 30s; a second poller that fetches the same lists every
 * half minute would multiply that. Only sections this person can open are asked.
 */

/** How many rows the list shows. A "recent" list is a sample, not an inventory. */
export const RECENT_LIMIT = 8;

/**
 * The word for a status code, plus the ink it is set in.
 *
 * The bottom two are not a status but the two ways in which there is none
 * (see RECENT_STATUS in studioRecentSources.js). They deliberately get the same
 * neutral ink as "draft": a green tick on a row that reports no status is exactly
 * the invented reassurance this list must not give.
 */
export const STATUS_LABELS: Readonly<Record<string, StatusLabel>> = Object.freeze({
    [RECENT_STATUS.FAILED]: { key: 'studio.recent.status_failed', fallback: 'Failed', tone: 'var(--error)' },
    [RECENT_STATUS.PROCESSING]: { key: 'studio.recent.status_processing', fallback: 'Processing', tone: 'var(--warning)' },
    [RECENT_STATUS.UNPUBLISHED_CHANGES]: { key: 'studio.recent.status_unpublished_changes', fallback: 'Unpublished changes', tone: 'var(--warning)' },
    [RECENT_STATUS.PUBLISHED]: { key: 'studio.recent.status_published', fallback: 'Published', tone: 'var(--success)' },
    [RECENT_STATUS.ACTIVE]: { key: 'studio.recent.status_active', fallback: 'On', tone: 'var(--success)' },
    [RECENT_STATUS.READY]: { key: 'studio.recent.status_ready', fallback: 'Ready', tone: 'var(--success)' },
    [RECENT_STATUS.DRAFT]: { key: 'studio.recent.status_draft', fallback: 'Draft', tone: 'var(--text-tertiary)' },
    [RECENT_STATUS.PAUSED]: { key: 'studio.recent.status_paused', fallback: 'Paused', tone: 'var(--text-tertiary)' },
    [RECENT_STATUS.UNKNOWN]: {
        key: 'studio.recent.status_unknown', fallback: 'Status unknown', tone: 'var(--text-tertiary)',
        hintKey: 'studio.recent.status_unknown_hint',
        hintFallback: 'This list reports a status for this kind, but this row carried none.',
    },
    [RECENT_STATUS.UNSUPPORTED]: {
        key: 'studio.recent.status_unsupported', fallback: 'No status', tone: 'var(--text-tertiary)',
        hintKey: 'studio.recent.status_unsupported_hint',
        hintFallback: 'This kind does not report a status in this list.',
    },
});

/** The label for a code; never undefined, because there is always a word on the row. */
export function statusLabel(status: string): StatusLabel {
    return STATUS_LABELS[status] || STATUS_LABELS[RECENT_STATUS.UNKNOWN];
}

/* ── De bronnen die deze persoon mag vragen ───────────────────────────────── */

/**
 * The sections this list is built from, derived from the two registers:
 * `sections` (the already-gated rows from studioNav.js) intersected with
 * STUDIO_RECENT_SOURCES.
 *
 * Four kinds of section drop out, and they are not the same:
 *   - `locked`      → skipped. A sign, not a door; there is nothing to read
 *   - built-in, no source → silent. Forms and Runs deliberately have none:
 *                     a form IS an automation (and so arrives via aiTasks),
 *                     and a run is an event, not a thing someone edits
 *   - RUNTIME MODULE, no source → NOT silent. An installed-remote module IS in
 *                     `sections` but has no endpoint contract this list can
 *                     read. Staying silent would mean that someone who works
 *                     only in it sees "Nothing edited yet" with `complete: true`
 *                     — a reassurance about work we never asked about. So they
 *                     go to `unsupported`, by name
 *   - no id/URL   → silent; a descriptor without a segment has nowhere to go
 */
export function recentSourcesFor(sections: ReadonlyArray<RecentSection | null | undefined> | null | undefined): {
    asked: RecentAsk[];
    skipped: string[];
    unsupported: string[];
} {
    const asked: RecentAsk[] = [];
    const skipped: string[] = [];
    const unsupported: string[] = [];
    for (const app of sections || []) {
        if (!app || !app.id) continue;
        const source = STUDIO_RECENT_SOURCES[app.id];
        if (!source || typeof source.url !== 'string' || !source.url) {
            // Een runtime-module herken je aan haar locale-bewuste label().
            // Een ingebouwde sectie zonder bron is een bewuste keuze hierboven.
            if (typeof app.label === 'function') unsupported.push(app.id);
            continue;
        }
        if (!app.urlSegment) continue;
        if (app.locked) { skipped.push(app.id); continue; }
        asked.push({
            sectionId: app.id,
            kind: app.kind || null,
            urlSegment: app.urlSegment,
            url: source.url,
        });
    }
    return {
        asked,
        skipped: [...new Set(skipped)].sort(),
        unsupported: [...new Set(unsupported)].sort(),
    };
}

/* ── De pure evaluator ────────────────────────────────────────────────────── */

/** A readable timestamp in ms, or null. NaN is not a time. */
export function timeOf(updatedAt: string | null | undefined): number | null {
    if (!updatedAt) return null;
    const t = new Date(updatedAt).getTime();
    return Number.isFinite(t) ? t : null;
}

/**
 * One payload → rows the screen can draw.
 *
 * Row by row through the mapper of the register, so the RAW row (where the
 * status lives) and the normalised row (where name and description live) stay
 * together; normaliseRecentRows throws away rows without an id, so an index
 * link across the whole list would silently shift.
 *
 * A body that does not yield an array is NOT an empty section but an answer
 * this client cannot read — `whole: false`, and the caller names the gap.
 */
export function evaluateRecentSection(section: RecentAsk, payload: RecentPayload): { entries: RecentEntry[]; whole: boolean } {
    const source = STUDIO_RECENT_SOURCES[section?.sectionId];
    if (!source) return { entries: [], whole: false };
    const rows = source.pick ? source.pick(payload) : payload;
    if (!Array.isArray(rows)) return { entries: [], whole: false };

    const entries: RecentEntry[] = [];
    for (const row of rows) {
        const [item] = normaliseRecentRows(section.sectionId, [row]);
        if (!item) continue;
        entries.push({
            key: `${section.sectionId}:${item.id}`,
            id: item.id,
            sectionId: section.sectionId,
            kind: section.kind,
            name: item.name || null,
            description: item.description || null,
            updatedAt: item.updatedAt || null,
            at: timeOf(item.updatedAt),
            status: recentStatusOf(section.sectionId, row),
            // Same shape as attentionLink.attentionPath: a row that cannot go anywhere
            // would rather not navigate than navigate to /null.
            path: `studio/${section.urlSegment}/${encodeURIComponent(item.id)}`,
        });
    }
    return { entries, whole: true };
}

/**
 * Everything that was found, newest first, cut off at `limit`.
 *
 * Rows without a readable timestamp go at the back: they cannot be placed in an
 * order called "recently edited", and throwing them away would hide work. On an
 * equal time the key decides, so two renders of the same data do not swap order.
 */
export function mergeRecentEntries(
    lists: ReadonlyArray<ReadonlyArray<RecentEntry | null | undefined> | null | undefined> | null | undefined,
    limit = RECENT_LIMIT,
): RecentEntry[] {
    const all: RecentEntry[] = [];
    for (const list of lists || []) for (const entry of list || []) if (entry) all.push(entry);
    all.sort((a, b) => {
        if (a.at === b.at) return String(a.key).localeCompare(String(b.key));
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return b.at - a.at;
    });
    return all.slice(0, Math.max(0, limit));
}

/* ── Het netwerk ──────────────────────────────────────────────────────────── */

/** The ONLY network call in this module. Throws on anything that is not a readable answer. */
async function fetchSection(section: RecentAsk): Promise<{ refused: boolean; payload: RecentPayload }> {
    const res = await authFetch(`${API_BASE}${section.url}`);
    // The server refuses in words: this is not yours, and therefore not a gap.
    if (res.status === 403) return { refused: true, payload: null };
    // 401 does NOT belong here: an expired session is "could not look", not "not yours", and a list that looks empty on that is lying.
    if (!res.ok) throw new Error(`GET ${section.url} → ${res.status}`);
    return { refused: false, payload: await res.json() };
}

/**
 * One section to a verdict. NEVER THROWS — the three answers:
 *   refused     → no rows, no gap
 *   read        → the rows that were in it
 *   fell over   → no rows, and a gap with the name of the section
 */
export async function runRecentSection(section: RecentAsk): Promise<RecentSectionResult> {
    try {
        const { refused, payload } = await fetchSection(section);
        if (refused) return { sectionId: section.sectionId, entries: [], refused: true, gap: false };
        const { entries, whole } = evaluateRecentSection(section, payload);
        return { sectionId: section.sectionId, entries, refused: false, gap: !whole };
    } catch {
        return { sectionId: section.sectionId, entries: [], refused: false, gap: true };
    }
}

/**
 * The whole list. Resolves to
 *
 *   { items, unavailable, skipped, complete }
 *
 * `items`        the `limit` newest rows across all requested sections
 * `unavailable`  every section that could not be read — the screen names them
 * `skipped`      sections that are not this person's (locked or 403):
 *                no gap, and no reason to show a warning that everyone sees
 *                every day and therefore learns to ignore
 * `unsupported`  sections for which this build cannot read a list
 * `complete`     no single gap, no unanswered gate and no unreadable
 *                section — the only right to say "nothing edited yet" instead
 *                of "we could not look everywhere"
 */
export async function runRecentWork(
    sections: ReadonlyArray<RecentSection | null | undefined> | null | undefined,
    { limit = RECENT_LIMIT, gatesResolved = true }: { limit?: number; gatesResolved?: boolean } = {},
): Promise<RecentWork> {
    const { asked, skipped: locked, unsupported } = recentSourcesFor(sections);
    const results = await Promise.all(asked.map((section) => runRecentSection(section)));
    const unavailable = results.filter((r) => r.gap).map((r) => r.sectionId).sort();
    const refused = results.filter((r) => r.refused).map((r) => r.sectionId);
    // THE GATES THEMSELVES ARE AN ANSWER THAT CAN BE MISSING.
    //
    // resolveStudioNav LEAVES a gated section out entirely for as long as the
    // entitlements answer is missing or has fallen away (studioApps.jsx:138-141;
    // studioNav.js deliberately sets lockReason to () => null then, because a
    // licence that is still loading must not appear on screen as "higher plan
    // needed"). Such a section is therefore NOT in `sections`, and this function
    // cannot miss it. Without this flag the result is that we never ask for seven
    // lists and lay "Nothing edited yet" with `complete: true` over them — a clean
    // health statement about lists that were never asked for, in the ordinary
    // loading second of EVERY opening. Unknown narrows: no right to the
    // reassurance as long as the gates have no answer.
    const gateGap = gatesResolved ? [] : ['gates'];
    return {
        items: mergeRecentEntries(results.map((r) => r.entries), limit),
        unavailable: [...gateGap, ...unavailable],
        skipped: [...new Set([...locked, ...refused])].sort(),
        // Sections this build cannot read. Not a gap (nothing is broken)
        // and not a secret (they are shown by name on the screen), but also no
        // reason to say that nothing has been edited.
        unsupported,
        complete: unavailable.length === 0 && gateGap.length === 0 && unsupported.length === 0,
    };
}

/**
 * The kinds on this list that report no status, in the order they appear on
 * the screen. The screen puts one sentence under it; without that sentence a
 * row without a status word is an empty spot with no explanation.
 */
export function statuslessKinds(
    items: ReadonlyArray<Partial<Pick<RecentEntry, 'status' | 'kind' | 'sectionId'>> | null | undefined> | null | undefined,
): string[] {
    const out: string[] = [];
    for (const item of items || []) {
        if (item?.status !== RECENT_STATUS.UNSUPPORTED) continue;
        const kind = item.kind || item.sectionId;
        if (kind && !out.includes(kind)) out.push(kind);
    }
    return out;
}

export default runRecentWork;
