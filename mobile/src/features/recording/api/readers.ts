/**
 * Contract readers for the meeting-notes payloads. Every field is traced in
 * model/types.ts: the list row is `mapRow` in server/stores/transcriptionStore.js,
 * the detail is `shapeRow` + `withInsightsPolicy` (routes/transcriptions/shared.js).
 * A field the pipeline added late (chapters, decisions, per-speaker prose) reads
 * as empty rather than undefined, so a note written before it still renders.
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { MeetingReport, TagCount } from '../model/library';
import type { RegenerateResult } from '../model/regenerate';
import type {
    ActionItem,
    AudioAvailability,
    Chapter,
    Decision,
    OpenQuestion,
    Speaker,
    Transcription,
    TranscriptionAccepted,
    TranscriptionStatus,
    TranscriptionSummary,
    TranscriptSegment,
} from '../model/types';

const STATUSES: readonly TranscriptionStatus[] = ['processing', 'completed', 'failed'];

/** `mapRow`. The server itself defaults a missing status to 'completed'. */
const SUMMARY_SPEC = {
    id: field.str(''),
    title: field.str(''),
    fileName: field.strOrNull,
    language: field.strOrNull,
    durationSeconds: field.numOrNull,
    speakerCount: field.numOrNull,
    segmentCount: field.numOrNull,
    status: field.oneOf(STATUSES, 'completed'),
    provider: field.str(''),
    source: field.str('upload'),
    isPublished: field.bool(false),
    sharedGroups: field.strArray,
    tags: field.optStrArray,
    organizationId: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
    transcriptSnippet: field.optStr,
    summarySnippet: field.optStr,
    isOwner: field.bool(false),
    ownerId: field.str(''),
};

const readSummaryRows: (raw: unknown) => TranscriptionSummary[] = shapeListOf(SUMMARY_SPEC);

export function readTranscriptionList(raw: unknown): TranscriptionSummary[] {
    return readSummaryRows(pick(raw, 'transcriptions'));
}

const readSegment: (raw: unknown) => TranscriptSegment = shapeOf({
    speaker: field.str(''),
    speakerId: field.optStr,
    start: field.num(0),
    end: field.num(0),
    text: field.str(''),
    gap: field.optBool,
});

const readSpeaker: (raw: unknown) => Speaker = shapeOf({
    id: field.str(''),
    speakingTime: field.optStr,
    speakingSeconds: field.optNum,
    segments: field.optNum,
    source: field.optStr,
    summary: field.optStr,
});

/**
 * NOT an allow-list, unlike every other reader here. A checkbox tap PATCHes
 * the whole array back, so a field this client does not name (`destination`,
 * `source`, `aiText`, …) has to ride through untouched or the tap deletes it
 * from the note. The server's shapeActionItem is the allow-list; this only
 * makes sure there is an object with a text to render.
 */
function readActionItem(raw: unknown): ActionItem {
    const item = field.recordOrNull(raw) ?? {};
    return { ...item, text: field.str('')(item.text) };
}

const readDecision: (raw: unknown) => Decision = shapeOf({
    text: field.str(''),
    timestamp: field.optStr,
});

const readQuestion: (raw: unknown) => OpenQuestion = shapeOf({
    text: field.str(''),
    timestamp: field.optStr,
    open: field.optBool,
});

const readChapter: (raw: unknown) => Chapter = shapeOf({
    title: field.str(''),
    start: field.str(''),
    summary: field.optStr,
});

/** `describeAudio`. Absent reads as the server's own "nothing is known" answer. */
const readAudio: (raw: unknown) => AudioAvailability = shapeOf({
    available: field.bool(false),
    durable: field.bool(false),
    localOnly: field.bool(false),
    storageConfigured: field.bool(false),
    recoverable: field.bool(false),
    capture: field.strOrNull,
});

const readDetail: (raw: unknown) => Transcription = shapeOf({
    ...SUMMARY_SPEC,
    tags: field.strArray,
    fullText: field.str(''),
    transcript: field.str(''),
    summary: field.str(''),
    segments: field.list(readSegment),
    speakers: field.list(readSpeaker),
    actionItems: field.list(readActionItem),
    decisions: field.list(readDecision),
    questions: field.list(readQuestion),
    attendees: field.strArray,
    chapters: field.list(readChapter),
    numSpeakers: field.numOrNull,
    audio: readAudio,
    // A works-council switch: when it is missing, per-person airtime stays hidden.
    perPersonInsights: field.bool(false),
});

/** `GET /:id`, and the whole note the speaker routes answer with. */
export const readTranscription: (raw: unknown) => Transcription | null = nullable(readDetail);

export const readRegenerateResult: (raw: unknown) => RegenerateResult | null = nullable(
    shapeOf({
        summary: field.str(''),
        actionItems: field.list(readActionItem),
        decisions: field.list(readDecision),
        questions: field.list(readQuestion),
        chapters: field.list(readChapter),
        speakers: field.list(readSpeaker),
        artifactsRegenerated: field.optBool,
    }),
);

/** `GET /tags` answers a bare array of `{ tag, count }`; a blank tag is no chip. */
const readTagRows: (raw: unknown) => TagCount[] = shapeListOf({ tag: field.str(''), count: field.num(0) });

export function readTagCounts(raw: unknown): TagCount[] {
    return readTagRows(raw).filter((row) => row.tag);
}

/**
 * `POST /report`. `usedTranscripts` defaults to true: only an explicit false
 * says the answer was built from summaries, which the sheet then says.
 */
export const readReport: (raw: unknown) => MeetingReport | null = nullable(
    shapeOf({
        report: field.str(''),
        usedTranscripts: field.bool(true),
        truncatedNotes: field.num(0),
    }),
);

/** The upload's 202. An id-less answer is still "no note", which the caller refuses. */
export const readAccepted: (raw: unknown) => TranscriptionAccepted | null = nullable(
    shapeOf({
        id: field.str(''),
        status: field.oneOf(STATUSES, 'processing'),
        title: field.str(''),
        fileName: field.optStr,
    }),
);

/** The export route answers text; anything else is nothing to share. */
export function readExportBody(raw: unknown): string {
    return typeof raw === 'string' ? raw : '';
}
