/**
 * Meeting-notes shapes, as the server actually sends them.
 *
 * Every field here is traced to a source file rather than guessed:
 *
 *   - The list payload is `mapRow` in server/stores/transcriptionStore.js.
 *   - The detail payload is `shapeRow` plus `withInsightsPolicy` in
 *     server/routes/transcriptions/shared.js, which STRIPS `audioPath` /
 *     `audioStorageKey` (server-side locations) and replaces them with the
 *     derived `audio` descriptor. That is why nothing below has a file path:
 *     playback and download go through `GET /:id/audio`, which re-checks ACL.
 *   - `segments` / `speakers` come from `buildTranscriptArtifacts` in
 *     core/meetingNotes/transcriptArtifacts.js.
 *   - `actionItems` / `decisions` / `questions` / `chapters` are the JSON
 *     contracts spelled out in the extraction prompts in
 *     core/meetingNotes/summaryHelpers.js.
 *
 * Optionality is not decoration. A note written before a column existed comes
 * back without it — the server has shipped chapters, decisions, questions and
 * per-speaker prose at different times — so anything the pipeline adds late is
 * optional here and every screen has to render without it.
 */

/**
 * `status` is a three-state machine, not a boolean.
 *
 * 'processing' is the normal state for the first few minutes after an upload
 * (the route answers 202 and finishes the pipeline in the background), and
 * `timeoutStuckTranscriptions` flips anything stuck there for 180 minutes to
 * 'failed'. A failed note keeps its saved audio, which is what makes Retry
 * (POST /:id/reprocess) meaningful rather than cosmetic.
 */
export type TranscriptionStatus = 'processing' | 'completed' | 'failed';

/** How the audio got here. Decides what we can honestly say if it goes missing. */
export type CaptureSource = 'recording' | 'upload' | string;

export interface TranscriptSegment {
    /** Display name after speaker naming; the raw diarizer id before it. */
    speaker: string;
    speakerId?: string;
    start: number;
    end: number;
    text: string;
    /** A stretch of audio that could not be transcribed — a hole, not a turn. */
    gap?: boolean;
}

export interface Speaker {
    /** The speaker's display name. Doubles as the identity key for renames. */
    id: string;
    /** Pre-formatted "MM:SS" from the server; do not recompute it. */
    speakingTime?: string;
    speakingSeconds?: number;
    segments?: number;
    /**
     * Provenance. 'voiceprint' means an acoustic match settled this name and
     * `/reidentify-speakers` must not overwrite it; 'manual' means a human
     * corrected it, which outranks everything.
     */
    source?: 'voiceprint' | 'manual' | string;
    /** Per-speaker prose for the Insights panel. Added late; often absent. */
    summary?: string;
}

/**
 * One action item.
 *
 * The shape is `shapeActionItem` in server/core/meetingNotes/actionItems.js,
 * which rebuilds every item from an allow-list — so a field this type does not
 * name is a field the phone can lose.
 *
 * FOUR OF THESE THE PHONE DOES NOT SHOW: `id`, `source`, `segmentIndex` and
 * `destination` are named here precisely BECAUSE nothing renders them. Today
 * they survive only by accident: the detail screen toggles `done` with
 * `{ ...item, done: !item.done }` (app/recordings/[id].tsx) and PATCHes the
 * whole array back, so the spread carries them through. Rewrite that screen to
 * build items field by field — the obvious tidy-up — and every one of them is
 * dropped on the next checkbox tap:
 *
 *   - `destination` is the chip saying where the person already sent this
 *     action. Losing it costs them a choice they made, silently.
 *   - `source` is the only thing that says a person wrote this item rather
 *     than the model. An item that arrives back without it can be re-derived
 *     as 'ai' from its id, so the next "Regenerate" deletes the user's own
 *     item (mergeRegeneratedActionItems replaces only `source: 'ai'`).
 *   - `id` is what the merge matches on, and `segmentIndex` is the transcript
 *     line the item is anchored to.
 */
export interface ActionItem {
    text: string;
    /**
     * Server-minted, and stable across regenerates. `ai-<n>` is the
     * extractor's own namespace — never mint one on the phone.
     */
    id?: string;
    /**
     * Who put this here. Absent on notes written before M3; the server then
     * derives it from the id, which is why an item must be sent back with the
     * id it arrived with.
     */
    source?: 'ai' | 'user';
    /** Index of the transcript line this was anchored to. 0 is a real line. */
    segmentIndex?: number;
    /**
     * Where this action was already sent. A REFERENCE, never the action's
     * text: kind + id + label is all that leaves Bee Flow (BFSF-441), and the
     * kind list is closed on the server (DESTINATION_KINDS).
     *
     *   ref      the container — the automation, the datatable, the KB.
     *   itemRef  what the write created inside it (the run, the row, the
     *            source). Optional: an automation run that outlives its
     *            response window is recorded with no run id rather than a
     *            made-up one.
     */
    destination?: {
        kind: 'automation' | 'datatable_row' | 'kb';
        ref: string;
        label?: string;
        /** ISO stamp, put on by the server — a client clock is not a clock. */
        at?: string;
        itemRef?: string;
    };
    /**
     * What the model originally wrote, kept even when it equals `text`. It is
     * the yardstick for "somebody retyped this", so dropping it on the way
     * back makes the NEXT correction unmeasurable.
     */
    aiText?: string;
    assignee?: string;
    /** "MM:SS" or "HH:MM:SS" into the recording, as spoken. */
    timestamp?: string;
    /** "YYYY-MM-DD", only when a concrete deadline was actually spoken. */
    due?: string;
    done?: boolean;
    /**
     * The item was in the previous pass, the newest regenerate no longer
     * produced it, and the server kept it anyway because somebody had checked
     * it off or retyped it. Letting it through unmarked would have the card
     * claim the model just produced it.
     */
    orphaned?: boolean;
}

export interface Decision {
    text: string;
    timestamp?: string;
}

export interface OpenQuestion {
    text: string;
    timestamp?: string;
    /** True when the question was raised but never answered in the meeting. */
    open?: boolean;
}

export interface Chapter {
    title: string;
    /** A clock string ("12:30" / "01:05:30"), never a number of seconds. */
    start: string;
    summary?: string;
}

/**
 * The derived playability descriptor from `describeAudio` (shared.js).
 *
 * Worth reading carefully before writing any copy against it: `recoverable`
 * means the local copy is gone but a durable one exists (an outage), while
 * `localOnly` means it is playable right now but one pod restart from gone.
 * Telling someone to "upload it again" when `capture === 'recording'` is
 * always wrong — those bytes never existed anywhere else.
 */
export interface AudioAvailability {
    available: boolean;
    durable: boolean;
    localOnly: boolean;
    storageConfigured: boolean;
    recoverable: boolean;
    capture: CaptureSource | null;
}

/** One row of `GET /api/transcriptions` — deliberately smaller than the detail. */
export interface TranscriptionSummary {
    id: string;
    title: string;
    fileName: string | null;
    language: string | null;
    durationSeconds: number | null;
    speakerCount: number | null;
    segmentCount: number | null;
    status: TranscriptionStatus;
    provider: string;
    source: CaptureSource;
    isPublished: boolean;
    sharedGroups: string[];
    tags?: string[];
    organizationId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    /** First 2000 chars of the raw text, for client-side search. */
    transcriptSnippet?: string;
    /** First 400 chars of the generated summary. Enough for a list subtitle. */
    summarySnippet?: string;
    isOwner: boolean;
    ownerId: string;
}

/** `GET /api/transcriptions/:id`. */
export interface Transcription extends TranscriptionSummary {
    fullText: string;
    transcript: string;
    summary: string;
    segments: TranscriptSegment[];
    speakers: Speaker[];
    actionItems: ActionItem[];
    decisions: Decision[];
    questions: OpenQuestion[];
    tags: string[];
    attendees: string[];
    chapters: Chapter[];
    numSpeakers: number | null;
    audio: AudioAvailability;
    /**
     * The org's display policy for per-person stats. A works-council switch,
     * not an access boundary — but when it is false we must not RANK
     * colleagues by airtime, which is the whole point of it existing.
     */
    perPersonInsights: boolean;
}

/** What the upload route answers with — a 202, not a finished note. */
export interface TranscriptionAccepted {
    id: string;
    status: TranscriptionStatus;
    title: string;
    fileName?: string;
}

/**
 * The per-upload settings the capture form collects.
 *
 * Field names here are the CLIENT's; `api.ts` maps them onto the snake_case
 * multipart fields the route reads (`context_terms`, `num_speakers`,
 * `capture_mode`). Keeping the mapping in one place stops a rename here from
 * silently dropping a field on the wire.
 */
export interface CaptureSettings {
    title: string;
    language: string;
    /** Free text: "Tom, Gerard, René". The strongest input to speaker naming. */
    attendees: string;
    /** Product/jargon glossary that biases the transcriber. */
    contextTerms: string;
    /** Blank means Auto-detect. */
    numSpeakers: string;
}

/**
 * A recording held on THIS DEVICE that has not reached the server yet.
 *
 * This type is the reason the Record tab exists as more than a button. For a
 * meeting recorded in a room, the phone holds the only copy of the audio until
 * the upload succeeds — so an entry is removed only after the server has
 * acknowledged it, and a failure leaves the entry (and the file) exactly where
 * they were, retryable.
 */
export interface PendingRecording {
    /** Local id. Unrelated to any server id. */
    id: string;
    /** file:// path inside the app's DOCUMENT dir, never the cache dir. */
    uri: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number;
    createdAt: string;
    /**
     * 'recording' | 'upload' — sent as `capture_mode`. The server stores it so
     * that, if the audio is ever lost, it can tell the user the truth instead
     * of asking them to upload a file that never existed.
     */
    captureMode: 'recording' | 'upload';
    settings: CaptureSettings;
    status: 'queued' | 'uploading' | 'failed';
    /** 0..1. Transient — never restored from disk. */
    progress: number;
    attempts: number;
    /** Last failure, in words a person can act on. */
    error: string | null;
}
