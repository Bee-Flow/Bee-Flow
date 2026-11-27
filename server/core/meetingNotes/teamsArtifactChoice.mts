/**
 * Which artifact of one Teams meeting occurrence becomes the note: its
 * recording (Bee Flow transcribes it) or its Teams transcript (the text
 * Microsoft made). The organisation or the member chooses the source
 * (teamsNotesSettings.js `source`); the other one is the way back, so a
 * meeting with only one of the two still gives a note.
 *
 *   source 'recording'   the recording; else the transcript
 *   source 'transcript'  the transcript; else the recording, but only once
 *                        Teams has had time to publish the transcript
 *
 * Teams publishes a transcript shortly after the meeting, not at the same
 * moment as the recording. With source 'transcript' a meeting that has a
 * recording and no transcript yet therefore waits (the job stays claimable)
 * until TEAMS_TRANSCRIPT_WAIT_MINUTES after its end (default 30, 0 = do not
 * wait), so the recording is not transcribed for a transcript that was about
 * to arrive. A run the member is watching does not wait.
 *
 * Without the transcript permission, or with transcript access switched off
 * in the tenant, there is no transcript to wait for: the recording is used at
 * once.
 */

import { envInt } from '../../utils/envNumber.mts';

export type TextSource = 'recording' | 'transcript';

interface ArtifactItem { id?: string; createdDateTime?: string; endDateTime?: string }
interface Slot { meetingStart?: string | Date | null; meetingEnd?: string | Date | null }

export interface ChosenArtifact {
    kind: 'recording' | 'transcript';
    id: string;
    /** The OTHER artifacts of the same kind in this occurrence (a recording stopped and restarted makes one per part). */
    extraRecordings?: number;
}

/** The Graph listings and the slot matching of teamsArtifacts.js. */
export interface ArtifactChoiceDeps {
    listRecordings(session: unknown, meetingId: string): Promise<ArtifactItem[]>;
    listTranscripts(session: unknown, meetingId: string): Promise<ArtifactItem[]>;
    pickArtifactForSlot(items: ArtifactItem[], slot: Slot): ArtifactItem | null;
    artifactsForSlot(items: ArtifactItem[], slot: Slot): ArtifactItem[];
}

export interface ArtifactChoiceInput {
    session: unknown;
    meetingId: string;
    slot: Slot;
    source: TextSource;
    /** The session may read transcripts (the transcript permission was granted). */
    transcriptAllowed: boolean;
    /** Wait for a transcript that may still arrive; false for a run the member is watching. */
    wait?: boolean;
    now?: number;
}

export const DEFAULT_TRANSCRIPT_WAIT_MINUTES = 30;

/** How long after the meeting a recording waits for its transcript; 0 = not at all. */
export function transcriptWaitMs(): number {
    return envInt('TEAMS_TRANSCRIPT_WAIT_MINUTES', DEFAULT_TRANSCRIPT_WAIT_MINUTES, { min: 0 }) * 60_000;
}

function withExtras(d: ArtifactChoiceDeps, kind: ChosenArtifact['kind'], picked: ArtifactItem | null, items: ArtifactItem[], slot: Slot): ChosenArtifact | null {
    if (!picked?.id) return null;
    const extra = d.artifactsForSlot(items, slot).filter((a) => a?.id && a.id !== picked.id).length;
    return extra > 0 ? { kind, id: picked.id, extraRecordings: extra } : { kind, id: picked.id };
}

async function recordingOf(d: ArtifactChoiceDeps, a: ArtifactChoiceInput): Promise<ChosenArtifact | null> {
    const items = await d.listRecordings(a.session, a.meetingId);
    return withExtras(d, 'recording', d.pickArtifactForSlot(items, a.slot), items, a.slot);
}

/**
 * The transcript of the occurrence. `readable` is false when no transcript can
 * come: the permission is missing, or the tenant switched transcript access
 * off (which counts as "no transcript", not as a failure).
 */
async function transcriptOf(d: ArtifactChoiceDeps, a: ArtifactChoiceInput): Promise<{ artifact: ChosenArtifact | null; readable: boolean }> {
    if (!a.transcriptAllowed) return { artifact: null, readable: false };
    try {
        const items = await d.listTranscripts(a.session, a.meetingId);
        return { artifact: withExtras(d, 'transcript', d.pickArtifactForSlot(items, a.slot), items, a.slot), readable: true };
    } catch (err) {
        if ((err as { code?: string } | null)?.code !== 'transcript_access_disabled') throw err;
        return { artifact: null, readable: false };
    }
}

function meetingEndMs(slot: Slot): number {
    const end = new Date(slot.meetingEnd || slot.meetingStart || 0).getTime();
    return Number.isFinite(end) ? end : 0;
}

/** The artifact to ingest now, or null when there is none (yet). */
export async function chooseArtifact(d: ArtifactChoiceDeps, a: ArtifactChoiceInput): Promise<ChosenArtifact | null> {
    if (a.source !== 'transcript') {
        return await recordingOf(d, a) || (await transcriptOf(d, a)).artifact;
    }
    const transcript = await transcriptOf(d, a);
    if (transcript.artifact) return transcript.artifact;
    const recording = await recordingOf(d, a);
    if (!recording) return null;
    const stillComing = transcript.readable && a.wait !== false && (a.now ?? Date.now()) < meetingEndMs(a.slot) + transcriptWaitMs();
    return stillComing ? null : recording;
}

/** Ingest failures that mean "this transcript cannot be used", not "this meeting cannot be imported". */
const TRANSCRIPT_UNUSABLE = new Set(['transcript_access_disabled', 'speaker_attribution_disabled', 'empty_transcription']);

/** True when a failed transcript ingest may be answered with the recording instead. */
export function transcriptUnusable(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && TRANSCRIPT_UNUSABLE.has(code);
}
