/**
 * WHAT A TRANSCRIPT LINE CAN BECOME — the pure half of the per-line popover
 * (Meeting Notes artboard 1b, plan M4).
 *
 * Until M4 a transcript was read-only: the model extracted actions, decisions
 * and questions from the whole thing and a person could only correct what it
 * had found. The line popover turns that around — a person points at ONE
 * sentence and says what it is. This module builds what that produces, and
 * reads back which lines already produced something.
 *
 * ── EVERYTHING A PERSON MAKES HERE IS `source: 'user'` ──────────────
 * That single field is what carries this stage's promise. `POST
 * /:id/regenerate-summary` re-runs the extractor and rewrites the artifact
 * lists, and `core/meetingNotes/actionItems.js` keeps out of the way of
 * exactly the items marked this way (mergeRegeneratedActionItems for actions,
 * mergeRegeneratedNotes for decisions and questions — the second of those
 * exists BECAUSE of this module). Leaving the field off would not fail
 * anywhere visible; it would simply mean the sentence a person picked is gone
 * the next time they press "Opnieuw", with no undo. So the builders below set
 * it explicitly rather than leaning on the server's derivation, and the tests
 * next door pin it.
 *
 * ── IDS ARE THE SERVER'S ────────────────────────────────────────────
 * Nothing here mints one. `PATCH /api/transcriptions/:id` mints an id outside
 * the extractor's `ai-<n>` / `d-<n>` / `q-<n>` namespaces and hands the
 * cleaned list back; a client-invented id could land inside one of those
 * namespaces and be deleted by the very next regenerate.
 *
 * ── ALLOW-LIST, NEVER A SPREAD ──────────────────────────────────────
 * Same habit as lib/actionDestinations.js. A segment carries whatever the
 * transcription pipeline put on it — speaker ids, confidences, word-level
 * timings, and whatever a later provider adds — and `{ ...segment }` would
 * ship all of it into an action item other people in the org can read, into a
 * row in a table, into a knowledge base an agent answers from. Every builder
 * below names its fields.
 *
 * ── NO ENGLISH LIVES HERE ───────────────────────────────────────────
 * Labels are the caller's; it has `t()`, this module does not.
 */

import { formatDuration, formatSpeakerLabel } from './format';
import { segmentSpeakerId } from './playerData';

/** The three things a line can be marked as, and the order they chip in. */
const LINE_KINDS = Object.freeze<LineKind[]>(['action', 'decision', 'question']);

/** Which meeting field each kind lives in. */
const LINE_KIND_FIELD = Object.freeze({
    action: 'actionItems',
    decision: 'decisions',
    question: 'questions',
});

/** A segment as the transcript carries it; only the fields this module reads. */
export interface LineSegment {
    text?: unknown;
    start?: unknown;
}

/** One entry of the artifact lists (actions, decisions, questions) on a meeting. */
interface LineArtifact {
    id?: unknown;
    text?: unknown;
    segmentIndex?: unknown;
    open?: unknown;
}

/** The meeting fields this module reads. */
export interface LineMeeting {
    id?: unknown;
    title?: unknown;
    actionItems?: unknown;
    decisions?: unknown;
    questions?: unknown;
}

type LineKind = 'action' | 'decision' | 'question';

export interface LineMark {
    kind: LineKind;
    id: string;
    text: string;
    open?: boolean;
}

/** A trimmed string, or '' for anything that is not text. */
function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The line an artifact is anchored to, or `null`.
 *
 * Booleans and null must not become 0 — `Number(null) === 0` would chip the
 * first line of the meeting for every item that has no anchor at all, which
 * is every item written before M4.
 */
export function anchorOf(item?: { segmentIndex?: unknown } | null): number | null {
    const raw = item?.segmentIndex;
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : null;
}

/** `mm:ss` for a segment's start — the timestamp the artifact carries. */
function lineTimestamp(segment?: LineSegment | null): string {
    return formatDuration(Number(segment?.start) || 0);
}

/**
 * segmentIndex → what has been pulled out of that line, in LINE_KINDS order.
 *
 * The third column of the transcript reads this: a line that produced an
 * action carries an action chip, and a line that produced nothing carries
 * nothing. An INDEX, not a count — `buildFollowUpStats` (lib/insightsMetrics.js)
 * remains the one place that counts follow-ups, and nothing here re-derives
 * "how many are open", because two counts of the same thing drift.
 *
 */
export function buildLineMarks(meeting?: LineMeeting | null): Map<number, LineMark[]> {
    const marks = new Map<number, LineMark[]>();
    for (const kind of LINE_KINDS) {
        const list = meeting?.[LINE_KIND_FIELD[kind]];
        if (!Array.isArray(list)) continue;
        for (const item of list as LineArtifact[]) {
            const index = anchorOf(item);
            if (index === null) continue;
            const mark: LineMark = { kind, id: str(item.id), text: str(item.text) };
            // An answered question still marks its line — it says what the
            // line was, not what is still outstanding.
            if (kind === 'question') mark.open = item.open !== false;
            if (!marks.has(index)) marks.set(index, []);
            (marks.get(index) as LineMark[]).push(mark);
        }
    }
    return marks;
}

/**
 * The sentence itself, as a person would quote it.
 *
 * Speaker and clock included: a quote without them is a sentence nobody said
 * at no point in time, and the two are exactly what makes it checkable back
 * against the recording.
 */
export function lineQuote(segment?: LineSegment | null, { speakerLabel = '' }: { speakerLabel?: unknown } = {}): string {
    const body = str(segment?.text);
    if (!body) return '';
    const who = str(speakerLabel) || formatSpeakerLabel(segmentSpeakerId(segment));
    return `[${lineTimestamp(segment)}] ${who}: ${body}`;
}

/**
 * An action item made out of a line.
 *
 * No `assignee`: the speaker said the sentence, which is not the same as
 * owing the work, and guessing wrong writes somebody's name next to a task
 * that is not theirs. The person can fill it in on the card.
 */
export function buildLineActionItem(segment: LineSegment | null | undefined, index: unknown) {
    const body = str(segment?.text);
    if (!body || anchorOf({ segmentIndex: index }) === null) return null;
    return {
        text: body,
        source: 'user',
        done: false,
        segmentIndex: Number(index),
        timestamp: lineTimestamp(segment),
    };
}

/** A decision made out of a line. Same rule, one list over. */
export function buildLineDecision(segment: LineSegment | null | undefined, index: unknown) {
    const body = str(segment?.text);
    if (!body || anchorOf({ segmentIndex: index }) === null) return null;
    return {
        text: body,
        source: 'user',
        segmentIndex: Number(index),
        timestamp: lineTimestamp(segment),
    };
}

/**
 * The body for `POST /api/kb/:id/sources` with `kind:'text'` (the K1 text
 * source), carrying where it came from.
 *
 * `metadata` is the pair the server allow-lists (routes/knowledgeBases/
 * sources.js): which transcription, and which line of it. It is what lets the
 * meeting say "2 knowledge lines → <KB>" afterwards, and it is a REFERENCE —
 * two ids, no speaker name, no attendee list, nothing about the meeting
 * beyond its own id and title.
 *
 * The server refuses a body under three characters, so a line with nothing in
 * it answers `null` here rather than a request that 400s.
 */
export function buildLineKbSource(
    segment: LineSegment | null | undefined,
    index: unknown,
    meeting?: LineMeeting | null,
    { speakerLabel = '', labels = {} }: { speakerLabel?: unknown; labels?: Record<string, string | undefined> } = {},
) {
    const body = str(segment?.text);
    if (body.length < 3) return null;
    const meetingTitle = str(meeting?.title);
    const who = str(speakerLabel) || formatSpeakerLabel(segmentSpeakerId(segment));
    // Field by field, and each one labelled by the caller's t() — a missing
    // label falls back to the bare field id, a machine value rather than
    // English nobody can translate.
    const lines = [
        body,
        `${labels.speaker || 'speaker'}: ${who}`,
        `${labels.timestamp || 'timestamp'}: ${lineTimestamp(segment)}`,
    ];
    if (meetingTitle) lines.push(`${labels.meeting_title || 'meeting_title'}: ${meetingTitle}`);
    const title = (meetingTitle || body).slice(0, 200);
    const origin = lineOrigin(meeting, index);
    return {
        kind: 'text',
        name: title,
        config: { title, text: lines.join('\n'), ...(origin ? { metadata: origin } : {}) },
    };
}

/**
 * The two ids that say where a filed snippet came from, or `null`.
 *
 * Only a REAL pair: a transcription with no line, or a line with no
 * transcription, would make "this line is already filed" true for lines nobody
 * filed. The server allow-lists the same two fields on the way in.
 */
function lineOrigin(meeting: LineMeeting | null | undefined, index: unknown) {
    const transcriptionId = str(meeting?.id);
    const segmentIndex = anchorOf({ segmentIndex: index });
    if (!transcriptionId || segmentIndex === null) return null;
    return { transcriptionId, segmentIndex };
}

/**
 * The line as an action-SHAPED record, for the payload builders in
 * lib/actionDestinations.js (the table row).
 *
 * Reused rather than re-implemented: `buildRowValues` already narrows to
 * writable columns, refuses a field id outside ACTION_FIELD_IDS and leaves an
 * empty value out entirely. A second builder here would be a second place for
 * that narrowing to be forgotten.
 */
export function lineAsActionRecord(segment?: LineSegment | null, { speakerLabel = '' }: { speakerLabel?: unknown } = {}) {
    return {
        text: str(segment?.text),
        assignee: str(speakerLabel) || formatSpeakerLabel(segmentSpeakerId(segment)),
        timestamp: lineTimestamp(segment),
    };
}

/**
 * The FULL list with one item appended.
 *
 * Full, because `PATCH /api/transcriptions/:id` REPLACES the column: sending
 * only the new item would delete every other action, decision or question on
 * the note — including the ones a person made from other lines, which is the
 * very thing this stage exists to protect. A `null` item answers the list
 * unchanged, so a line with no text can never truncate it either.
 */
export function appendArtifact<T>(list: T[] | null | undefined, item: T | null | undefined): T[] {
    const current = Array.isArray(list) ? list : [];
    if (!item) return current;
    return [...current, item];
}
