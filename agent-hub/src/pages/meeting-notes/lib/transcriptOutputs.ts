/**
 * WHAT CAME OUT OF THIS TRANSCRIPT — the pure half of the side panel (Meeting Notes artboard 1b, plan M4 step 2).
 *
 * Step 1 gave each line a popover: from here a sentence becomes an action, a decision, a knowledge rule, a table row. This panel is the other side of that button — what has by now been taken OUT of this meeting, next to the transcript it comes from.
 *
 * ── NOTHING HERE COUNTS SOMETHING THAT IS ALREADY COUNTED ───────────
 * The action items, decisions and open questions come from `buildFollowUpStats` (lib/insightsMetrics.js) — the same function that feeds the Insights tab. The speakers come from `buildInsightsModel().people`, precisely the data that PeopleTab draws. This file adds two things to that which exist nowhere else, and nothing more:
 *
 *   1. which knowledge bases contain lines from this transcript, from the usage rows the server already supplies;
 *   2. whether the number of recognised speakers lags behind the attendee list.
 *
 * ── "EMPTY" AND "UNREADABLE" ARE TWO ANSWERS ──────────────────────
 * Both functions below have an explicit unknown state, and that always narrows. A KB scan that could not run must never be read as "nothing from this meeting is in a knowledge base", and asking a question about a speaker list that was not loaded ("was Marijke there?") is worse than asking no question: it names a name on the basis of nothing.
 *
 * ── THE GATE LIVES IN THE MODEL, NOT IN THE FORMATTING ──────────────
 * `buildInsightsModel` does not build `people` at all when the organisation has per-person statistics switched off. This panel reads that model and does not go around it: `buildSpeakerCheck` receives the gate, and with the gate closed it names no name — only two counts, the same narrowing that `topics.blocks` already does (duration stays, attribution disappears).
 */

import { buildSilentAttendees } from './insightsMetrics.helpers';
import type { InsightsModel } from '../detail/insights/insights.types';

/** De drie antwoorden op "hebben we iedereen herkend?". */
export const SPEAKER_CHECK = Object.freeze({
    /** One of the two lists could not be read — ask nothing. */
    UNKNOWN: 'unknown',
    /** Even veel sprekers als aanwezigen, of geen aanwezigenlijst om mee te vergelijken. */
    COMPLETE: 'complete',
    /** Fewer recognised speakers than attendees — this is where the question belongs. */
    GAP: 'gap',
});

/** De vier antwoorden op "welke kennisbanken hebben regels hiervan?". */
export const KNOWLEDGE_LINES = Object.freeze({
    /** De usage-fetch loopt nog. */
    LOADING: 'loading',
    /** The scan could not run AND yielded nothing — we do not know. */
    UNKNOWN: 'unknown',
    /** Een antwoord. `partial` zegt of er iets ongecontroleerd bleef. */
    READY: 'ready',
});

/** Names from a list, or `null` if it is not a list (unreadable ≠ empty). */
function readNames(value: string | (string | number | null)[] | undefined) {
    if (!Array.isArray(value)) return null;
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

/**
 * "2 knowledge rules → Sales" — which knowledge bases contain pieces of this transcript.
 *
 * Reads the rows of the ONE usage fetch that MeetingDetail already makes (`useUsage('meeting', id)`), not a second request: the bar under the tags, the Used-by tab, the deletion confirmation and this panel must say the same thing about the same meeting. The server counts the filed rules per knowledge base (`lineCount`, core/meetingNotes/meetingUsage.js); nothing is recounted here.
 *
 * `lineCount` is also what distinguishes a filed rule from a kb that gathers this meeting via a TAG. The second is another claim — "everything with this label ends up here" — and belongs in the outputs bar, not in "taken out of this".
 *
 * @param {Array|null|undefined} usage rows from useUsage; `null` = not yet loaded
 * @param {{unchecked?: string[], error?: any}} [opts]
 * @returns {{state: string, partial: boolean, rows: Array, total: number}}
 */
interface UsageRow {
    kind: string;
    id: string;
    title?: string | null;
    role?: string;
    lineCount?: number;
    ownerId?: string;
    siteLabel?: string;
}

export function buildKnowledgeLines(usage: (UsageRow | null)[] | null | undefined, { unchecked = [], error = null }: { unchecked?: string[]; error?: unknown } = {}) {
    if (usage === null || usage === undefined) {
        return { state: KNOWLEDGE_LINES.LOADING, partial: false, rows: [], total: 0 };
    }
    const rows = (Array.isArray(usage) ? usage : []).filter(
        (r) => r && r.kind === 'kb' && Number.isInteger(r.lineCount) && (r.lineCount as number) > 0,
    );
    const total = rows.reduce((n, r) => n + ((r as UsageRow).lineCount as number), 0);
    // The kb scan could not run (fully). With rows this is "at least this";
    // without rows it is not a zero but an unknown.
    const blind = !!error || (Array.isArray(unchecked) && unchecked.includes('kb'));
    if (blind && rows.length === 0) {
        return { state: KNOWLEDGE_LINES.UNKNOWN, partial: true, rows: [], total: 0 };
    }
    return { state: KNOWLEDGE_LINES.READY, partial: blind, rows, total };
}

/**
 * "Second speaker not recognised — was X present?"
 *
 * THREE states, and the third is the reason this is a function and not a `speakers.length < attendees.length` in the formatting. Fewer speakers than attendees can namely also mean that no diarisation was readable at all — a note without segments, a provider that supplies no speakers, a failed pass. Then there is no shortfall but a gap in what we know, and a question that names someone's name is the worst possible answer to that.
 *
 * The speaker list is `model.talk.speakers`: who has the floor in the SEGMENTS. Deliberately not the stored `meeting.speakers` roster — that may contain a name that says nothing in the transcript, and it would then strike off a real unrecognised speaker.
 *
 * @param {object} meeting detail payload (only `attendees` is read)
 * @param {object|null} model result of buildInsightsModel (null = too little speech)
 * @param {{perPersonEnabled?: boolean}} [opts]
 * @returns {{state: string, speakerCount: number|null, attendeeCount: number|null,
 *            names: string[]|null}} `names` is null as soon as no name may be stated — with the gate closed, or outside the GAP state.
 */
export function buildSpeakerCheck(meeting: { attendees?: string | (string | number | null)[] } | null | undefined, model: InsightsModel | null, { perPersonEnabled = true } = {}) {
    const attendees = readNames(meeting?.attendees);
    const recognised = model?.talk?.speakers;
    const speakerCount = Array.isArray(recognised) ? recognised.length : null;
    const attendeeCount = attendees === null ? null : attendees.length;

    // Onbekend versmalt: zonder leesbare diarisatie, of zonder leesbare
    // aanwezigenlijst, wordt er niets gevraagd en niets beweerd.
    if (!speakerCount || attendees === null) {
        return { state: SPEAKER_CHECK.UNKNOWN, speakerCount, attendeeCount, names: null };
    }
    if (attendeeCount === 0 || speakerCount >= (attendeeCount as number)) {
        return { state: SPEAKER_CHECK.COMPLETE, speakerCount, attendeeCount, names: null };
    }
    return {
        state: SPEAKER_CHECK.GAP,
        speakerCount,
        attendeeCount,
        // PER-PERSOON. `buildSilentAttendees` is dezelfde voorzichtige
        // naamvergelijking die de Inzichten-tab gebruikt (twijfel telt als
        // aanwezig), en hij draait alleen als de organisatie dat toestaat —
        // met de gate dicht blijven alleen de twee aantallen over.
        names: perPersonEnabled ? buildSilentAttendees(attendees, recognised) : null,
    };
}
