/**
 * Meeting-notes endpoints.
 *
 * The router is mounted at `/api/transcriptions` (server/index.js), behind
 * `requireModule('meetingNotes')` and `requireCapability('meeting_notes')` —
 * so a 403 here is a licensing answer, not a bug, and every screen has to be
 * able to say so. Paths below are the full client-visible ones.
 *
 * Processing is ASYNCHRONOUS: the upload (api/upload.ts) answers 202 and the
 * pipeline writes its outcome onto the note later. There is no stream and no
 * webhook, so the client polls; PROCESSING_POLL_MS in hooks/queries.ts is the
 * only place that decides how often.
 */

import { api } from '@/core/api/client';
import { guardedDelete } from '@/core/api/deleteGuard';
import { downloadToCache } from '@/core/api/downloadFile';

import {
    readExportBody,
    readRegenerateResult,
    readReport,
    readTagCounts,
    readTranscription,
    readTranscriptionList,
} from './readers';
import type { MeetingReport, TagCount } from '../model/library';
import { audioCacheName } from '../model/player';
import type { RegenerateResult } from '../model/regenerate';
import type { ActionItem, Transcription, TranscriptionSummary } from '../model/types';

const notePath = (id: string) => `/api/transcriptions/${encodeURIComponent(id)}`;

// ── Reads ────────────────────────────────────────────────────────────

export async function listTranscriptions(signal?: AbortSignal, limit = 50): Promise<TranscriptionSummary[]> {
    return readTranscriptionList(await api.get<unknown>('/api/transcriptions', { signal, query: { limit } }));
}

export async function getTranscription(id: string, signal?: AbortSignal): Promise<Transcription | null> {
    return readTranscription(await api.get<unknown>(notePath(id), { signal }));
}

/**
 * The tag vocabulary with counts over every note the caller may read
 * (routes/transcriptions/tags.js), count DESC. Server-side because the list is
 * a page of 50: a vocabulary taken from the loaded rows misses every tag past it.
 */
export async function listTranscriptionTags(signal?: AbortSignal): Promise<TagCount[]> {
    return readTagCounts(await api.get<unknown>('/api/transcriptions/tags', { signal }));
}

/**
 * The saved recording, downloaded into the cache on the app's session (see
 * core/api/downloadFile.ts for why not by URL) and reused on the next play.
 * The route re-checks access and answers 404 when the audio is gone; the
 * reused copy lives in the session cache, which sign-out and a server switch
 * wipe (core/api/sessionCache.ts), so it never outlives that access.
 */
export async function downloadMeetingAudio(id: string, signal?: AbortSignal): Promise<string> {
    const file = await downloadToCache(`${notePath(id)}/audio`, audioCacheName(id), {
        signal,
        reuse: true,
        sessionScoped: true,
    });
    return file.uri;
}

/**
 * Markdown or plain-text export. The route sets Content-Disposition, which a
 * phone has no use for — we take the body and hand it to the share sheet.
 */
export async function exportTranscription(id: string, format: 'md' | 'txt'): Promise<string> {
    return readExportBody(await api.get<unknown>(`${notePath(id)}/export`, { query: { format } }));
}

// ── Writes ───────────────────────────────────────────────────────────

export async function renameTranscription(id: string, title: string): Promise<void> {
    await api.patch(notePath(id), { title });
}

/**
 * Replace the note's tags. Owner-only (404 for anyone else); the server trims,
 * caps each at 80 characters, de-duplicates and keeps at most 50.
 */
export async function setTranscriptionTags(id: string, tags: string[]): Promise<void> {
    await api.patch(notePath(id), { tags });
}

/**
 * One question over up to ten notes (routes/transcriptions/report.js): a
 * cited markdown answer, nothing stored. One smart-tier pass over several
 * whole transcripts, so it gets the long deadline and no retry.
 */
export async function reportMeetings(ids: string[], prompt: string): Promise<MeetingReport | null> {
    const res = await api.post<unknown>('/api/transcriptions/report', { ids, prompt }, {
        retry: false,
        timeoutMs: 5 * 60_000,
    });
    return readReport(res);
}

/** The WHOLE list, as it arrived plus the edit — see readActionItem for why. */
export async function setActionItems(id: string, actionItems: ActionItem[]): Promise<void> {
    await api.patch(notePath(id), { actionItems });
}

/**
 * Delete a meeting — two presses, because the server answers in between.
 *
 * The first, unconfirmed DELETE refuses with `409 in_use` whenever something
 * collects, runs on or holds a copy of the note — AND whenever a kind could not
 * be checked, which today is every note (the notebook scan is unanswerable; see
 * src/core/api/deleteGuard.ts). `confirmedBreaking` becomes `?confirm=1` and is
 * passed only after that answer was shown and the title typed against it.
 */
export async function deleteTranscription(id: string, opts: { confirmedBreaking?: boolean } = {}): Promise<void> {
    await guardedDelete(notePath(id), 'recording', opts.confirmedBreaking);
}

/**
 * Re-run the whole pipeline on the SAVED audio. Answers 202 and then behaves
 * exactly like a fresh upload — the note goes back to 'processing'.
 *
 * Its failure modes are the interesting part, and each has a code the UI must
 * branch on rather than showing the prose (model/reprocess.ts):
 *   409 already_processing        — a double-tapped Retry, or another device.
 *   410 audio_gone_recorded       — the only copy is gone. Nothing to be done.
 *   410 audio_gone_uploaded       — gone, but the user still has the original.
 *   503 audio_storage_unavailable — an outage; trying again later will work.
 */
export async function reprocessTranscription(id: string): Promise<void> {
    await api.post(`${notePath(id)}/reprocess`, undefined, { retry: false });
}

/**
 * Re-run the summary from the STORED transcript — no audio, no re-transcribe.
 *
 * Also re-extracts action items, decisions, questions and chapters, which
 * makes it the upgrade path for notes recorded before those existed.
 * `templateId` picks a saved custom template; `template` a built-in key.
 */
export async function regenerateSummary(
    id: string,
    choice: { template?: string; templateId?: string },
): Promise<RegenerateResult | null> {
    // One smart-tier LLM pass over a whole meeting. The default 30s deadline
    // times out on anything longer than a short stand-up.
    const res = await api.post<unknown>(`${notePath(id)}/regenerate-summary`, choice, {
        retry: false,
        timeoutMs: 5 * 60_000,
    });
    return readRegenerateResult(res);
}

/**
 * Rename and/or merge speakers in one atomic edit, and get the whole note back.
 *
 * Merges resolve first, then renames, both looked up against the ORIGINAL
 * names — so swapping two speakers' names is a supported edit rather than a
 * silent, irreversible merge. The server refuses (400 speaker_name_collision)
 * when two surviving speakers would end up sharing a name; that message is
 * written for a human and should be shown verbatim.
 */
export async function updateSpeakers(
    id: string,
    edit: { renames?: Record<string, string>; merges?: { from: string[]; into: string }[] },
): Promise<Transcription | null> {
    return readTranscription(await api.patch<unknown>(`${notePath(id)}/speakers`, edit, { retry: false }));
}

/**
 * Ask the model to name the speakers again from the stored text.
 *
 * Owner-only, and worth almost nothing without a roster: the single strongest
 * signal is knowing who was in the room, which is why `attendees` is offered
 * rather than hidden. Answers 422 when it still cannot decide — that is a
 * legitimate outcome to surface, not an error to swallow.
 */
export async function reidentifySpeakers(id: string, attendees?: string): Promise<Transcription | null> {
    const res = await api.post<unknown>(`${notePath(id)}/reidentify-speakers`, attendees ? { attendees } : {}, {
        retry: false,
        timeoutMs: 3 * 60_000,
    });
    return readTranscription(res);
}
