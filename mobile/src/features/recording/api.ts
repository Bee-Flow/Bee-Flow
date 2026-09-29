/**
 * Meeting-notes endpoints.
 *
 * The router is mounted at `/api/transcriptions` (server/index.js), behind
 * `requireModule('meetingNotes')` and `requireCapability('meeting_notes')` —
 * so a 403 here is a licensing answer, not a bug, and every screen has to be
 * able to say so. Paths below are the full client-visible ones.
 *
 * Two things about this API shape the whole feature:
 *
 *   1. `POST /api/transcriptions` is ASYNCHRONOUS. It answers 202 with a
 *      `{ id, status: 'processing' }` note the moment the bytes have landed,
 *      then transcribes, diarizes, names speakers and summarises in the
 *      background, writing the outcome onto that note. There is no stream and
 *      no webhook: the client polls. `useTranscriptionPolling` below is the
 *      only place that decides how often.
 *   2. The upload is multipart with the file under the field name `audio`
 *      (multer's `upload.single('audio')`), capped at 500 MB, and restricted
 *      to the extensions in ACCEPTED_AUDIO_EXTENSIONS — or any `audio/*`
 *      MIME type. Getting either wrong is a 400 from the fileFilter that
 *      reads like a server error.
 */

import type {
    CaptureSettings,
    Chapter,
    Decision,
    OpenQuestion,
    ActionItem,
    Speaker,
    Transcription,
    TranscriptionAccepted,
    TranscriptionSummary,
} from './types';
import { ApiError, api } from '../../api/client';
import { apiUrl } from '../../api/server';


export const recordingKeys = {
    all: ['transcriptions'] as const,
    list: ['transcriptions', 'list'] as const,
    detail: (id: string) => ['transcriptions', 'detail', id] as const,
    templates: ['transcriptions', 'summary-templates'] as const,
};

/**
 * What multer's fileFilter accepts (routes/transcriptions/upload.js). Kept
 * here so the picker can refuse a file BEFORE a 200 MB upload discovers it —
 * a rejection after ten minutes on mobile data is not a rejection, it is a
 * betrayal.
 */
export const ACCEPTED_AUDIO_EXTENSIONS = [
    '.mp3',
    '.wav',
    '.m4a',
    '.ogg',
    '.webm',
    '.flac',
    '.mp4',
    '.mpeg',
    '.aac',
] as const;

/** multer's `limits.fileSize`. Exceeding it answers 400, not 413. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** The transcription languages the web client offers, same order, Dutch first. */
export const TRANSCRIPTION_LANGUAGES: readonly { code: string; label: string }[] = [
    { code: 'nl', label: 'Dutch' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'German' },
    { code: 'fr', label: 'French' },
    { code: 'es', label: 'Spanish' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'pl', label: 'Polish' },
    { code: 'tr', label: 'Turkish' },
    { code: 'ja', label: 'Japanese' },
    { code: 'zh', label: 'Chinese' },
    { code: 'ko', label: 'Korean' },
    { code: 'ar', label: 'Arabic' },
    { code: 'ru', label: 'Russian' },
];

export function isAcceptedAudioName(name: string): boolean {
    const lower = name.toLowerCase();
    return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ── Reads ────────────────────────────────────────────────────────────

interface ListResponse {
    transcriptions?: TranscriptionSummary[];
}

export async function listTranscriptions(
    signal?: AbortSignal,
    limit = 50,
): Promise<TranscriptionSummary[]> {
    const res = await api.get<ListResponse>('/api/transcriptions', { signal, query: { limit } });
    return res?.transcriptions ?? [];
}

export async function getTranscription(id: string, signal?: AbortSignal): Promise<Transcription | null> {
    return api.get<Transcription>(`/api/transcriptions/${encodeURIComponent(id)}`, { signal });
}

/**
 * The Regenerate menu's options: built-in prompts plus any custom template the
 * caller can see. Mounted separately at /api/summary-templates.
 */
export interface SummaryTemplate {
    id: string;
    name: string;
    prompt?: string;
}

interface TemplatesResponse {
    builtins?: SummaryTemplate[];
    custom?: SummaryTemplate[];
    defaultTemplateId?: string | null;
}

export async function listSummaryTemplates(signal?: AbortSignal): Promise<{
    builtins: SummaryTemplate[];
    custom: SummaryTemplate[];
    defaultTemplateId: string | null;
}> {
    const res = await api.get<TemplatesResponse>('/api/summary-templates', { signal, retry: false });
    return {
        builtins: res?.builtins ?? [],
        custom: res?.custom ?? [],
        defaultTemplateId: res?.defaultTemplateId ?? null,
    };
}

/**
 * Playback URL for the saved recording. Range-capable and ACL-checked on every
 * request — which is precisely why the note payload carries no file path.
 */
export function audioUrl(id: string, download = false): string {
    return apiUrl(`/api/transcriptions/${encodeURIComponent(id)}/audio${download ? '?download=1' : ''}`);
}

// ── Writes ───────────────────────────────────────────────────────────

export async function renameTranscription(id: string, title: string): Promise<void> {
    await api.patch(`/api/transcriptions/${encodeURIComponent(id)}`, { title });
}

export async function setActionItems(id: string, actionItems: ActionItem[]): Promise<void> {
    await api.patch(`/api/transcriptions/${encodeURIComponent(id)}`, { actionItems });
}

export async function deleteTranscription(id: string): Promise<void> {
    await api.delete(`/api/transcriptions/${encodeURIComponent(id)}`);
}

/**
 * Re-run the whole pipeline on the SAVED audio. Answers 202 and then behaves
 * exactly like a fresh upload — the note goes back to 'processing'.
 *
 * Its failure modes are the interesting part, and each has a code the UI must
 * branch on rather than showing the prose:
 *   409 already_processing        — a double-tapped Retry, or another device.
 *   410 audio_gone_recorded       — the only copy is gone. Nothing to be done.
 *   410 audio_gone_uploaded       — gone, but the user still has the original.
 *   503 audio_storage_unavailable — an outage; trying again later will work.
 */
export async function reprocessTranscription(id: string): Promise<void> {
    await api.post(`/api/transcriptions/${encodeURIComponent(id)}/reprocess`, undefined, {
        retry: false,
    });
}

/** The `code` on a reprocess failure, when the server sent one. */
export function errorCode(error: unknown): string | null {
    if (!(error instanceof ApiError)) return null;
    const body = error.body;
    if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
        return (body as { code: string }).code;
    }
    return null;
}

export interface RegenerateResult {
    summary: string;
    actionItems: ActionItem[];
    decisions: Decision[];
    questions: OpenQuestion[];
    chapters: Chapter[];
    speakers: Speaker[];
    /**
     * Heeft de artefactpass daadwerkelijk gedraaid?
     *
     * Regenerate heeft bewust GEEN samenvatting-kanaal voor slecht nieuws: de
     * samenvatting die terugkomt is altijd vers. Dit veld is dus het enige
     * kanaal waarlangs de server kan zeggen dat het uitwerken van de
     * actiepunten, besluiten en vragen is omgevallen en de OUDE lijsten zijn
     * blijven staan. Een client die het niet leest toont een groene toast bij
     * een halve mislukking, en dan drukt niemand nog eens op Opnieuw.
     *
     * Optioneel omdat een oudere server het veld niet stuurt — en `undefined`
     * beweert niets, dus alleen een expliciete `false` is nieuws.
     */
    artifactsRegenerated?: boolean;
}

/** Wat de gebruiker na een regeneratie te zien krijgt. */
export interface RegenerateOutcome {
    kind: 'success' | 'warning';
    message: string;
}

/**
 * De uitkomst van een regeneratie in één zin — de web-client zegt hetzelfde.
 *
 * Puur, en met opzet buiten het scherm: dit is de regel die zegt WANNEER een
 * regeneratie geen onverdeeld succes is, en die hoort getest te kunnen worden
 * zonder een renderer.
 *
 * Drie gevallen, en alleen het eerste is groen:
 *   - de pass draaide en leverde alles op;
 *   - de pass viel om (`artifactsRegenerated === false`) — de samenvatting is
 *     wél vernieuwd, de lijsten zijn de oude;
 *   - de pass draaide, maar vond een of meer bewaarde punten niet terug
 *     (`orphaned`): die staan er nog omdat iemand ze had afgevinkt of
 *     overgetypt, en dat moet gezegd worden voordat de kaart doet alsof de AI
 *     ze zojuist opleverde.
 */
export function describeRegenerateOutcome(res: RegenerateResult | null): RegenerateOutcome {
    if (!res) return { kind: 'warning', message: 'The server sent no answer — nothing was changed.' };
    if (res.artifactsRegenerated === false) {
        return {
            kind: 'warning',
            message: 'Summary rewritten, but working out the action items, decisions and questions failed — the existing ones were kept.',
        };
    }
    const kept = Array.isArray(res.actionItems)
        ? res.actionItems.filter((item) => item && item.orphaned).length
        : 0;
    if (kept > 0) {
        return {
            kind: 'warning',
            message: `Summary rewritten. ${kept} action item(s) were kept: the new pass no longer found them, and they had been checked off or edited.`,
        };
    }
    return { kind: 'success', message: 'Summary rewritten' };
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
    return api.post<RegenerateResult>(
        `/api/transcriptions/${encodeURIComponent(id)}/regenerate-summary`,
        choice,
        // One smart-tier LLM pass over a whole meeting. The default 30s
        // deadline times out on anything longer than a short stand-up.
        { retry: false, timeoutMs: 5 * 60_000 },
    );
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
    return api.patch<Transcription>(`/api/transcriptions/${encodeURIComponent(id)}/speakers`, edit, {
        retry: false,
    });
}

/**
 * Ask the model to name the speakers again from the stored text.
 *
 * Owner-only, and worth almost nothing without a roster: the single strongest
 * signal is knowing who was in the room, which is why `attendees` is offered
 * rather than hidden. Answers 422 when it still cannot decide — that is a
 * legitimate outcome to surface, not an error to swallow.
 */
export async function reidentifySpeakers(
    id: string,
    attendees?: string,
): Promise<Transcription | null> {
    return api.post<Transcription>(
        `/api/transcriptions/${encodeURIComponent(id)}/reidentify-speakers`,
        attendees ? { attendees } : {},
        { retry: false, timeoutMs: 3 * 60_000 },
    );
}

/**
 * Markdown or plain-text export. The route sets Content-Disposition, which a
 * phone has no use for — we take the body and hand it to the share sheet.
 */
export async function exportTranscription(id: string, format: 'md' | 'txt'): Promise<string> {
    const body = await api.get<string>(`/api/transcriptions/${encodeURIComponent(id)}/export`, {
        query: { format },
    });
    return typeof body === 'string' ? body : '';
}

// ── Upload ───────────────────────────────────────────────────────────

export interface UploadProgressEvent {
    /** Bytes accepted by the socket so far. */
    loaded: number;
    /** Total bytes, including multipart framing. 0 when unknown. */
    total: number;
    /** 0..1, clamped. 0 when the total is unknown. */
    fraction: number;
}

export interface UploadInput {
    uri: string;
    fileName: string;
    mimeType: string;
    captureMode: 'recording' | 'upload';
    settings: CaptureSettings;
}

/**
 * POST the audio, with progress.
 *
 * This deliberately does NOT use `api.upload`. That helper is the right tool
 * for a small attachment, but it has no way to report progress, and a meeting
 * upload is the one request in this app where a person will sit and watch a
 * bar: it can be hundreds of megabytes over a hotel wifi, and a spinner with
 * no number is indistinguishable from a hang.
 *
 * XMLHttpRequest is what gives us `upload.onprogress`. On Android it runs on
 * React Native's own OkHttp client, which shares the ForwardingCookieHandler
 * with `expo/fetch` (see the note at the top of src/api/client.ts) — so the
 * session cookie is sent here exactly as it is everywhere else. It also
 * streams the file from disk when the part is `{ uri, name, type }`, so a
 * 500 MB recording never has to exist in JS memory.
 *
 * Errors are normalised to `ApiError` so `describeError` handles them the same
 * as every other call — including the 402 that means "plan limit", not "crash".
 */
export function uploadRecording(
    input: UploadInput,
    opts: { onProgress?: (e: UploadProgressEvent) => void; signal?: AbortSignal } = {},
): Promise<TranscriptionAccepted> {
    const { onProgress, signal } = opts;

    return new Promise<TranscriptionAccepted>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new ApiError('Upload cancelled.'));
            return;
        }

        const form = new FormData();
        // React Native's FormData accepts a file descriptor object here; the
        // DOM typings only know about Blob, hence the cast. The field name is
        // `audio` because the route is `upload.single('audio')`.
        form.append('audio', {
            uri: input.uri,
            name: input.fileName,
            type: input.mimeType,
        } as unknown as Blob);

        // snake_case on the wire — these are read straight off `req.body`.
        form.append('capture_mode', input.captureMode);
        form.append('language', input.settings.language);
        form.append('title', input.settings.title);
        if (input.settings.contextTerms.trim()) {
            form.append('context_terms', input.settings.contextTerms.trim());
        }
        if (input.settings.attendees.trim()) {
            form.append('attendees', input.settings.attendees.trim());
        }
        const speakers = input.settings.numSpeakers.trim();
        if (speakers) form.append('num_speakers', speakers);
        // `provider` is deliberately never sent. The engine decides which third
        // party the meeting audio reaches, and the admin's server-side default
        // is the only answer this client has any business giving.

        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl('/api/transcriptions'));
        xhr.responseType = 'text';
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('X-Beeflow-Client', 'android');
        // No timeout on purpose. The deadline that matters is the user's
        // patience, and they have Cancel; a fixed timeout would kill a large
        // upload that was making perfectly good progress.
        xhr.timeout = 0;

        const onAbort = () => xhr.abort();
        signal?.addEventListener('abort', onAbort);
        const cleanup = () => signal?.removeEventListener('abort', onAbort);

        if (onProgress) {
            xhr.upload.onprogress = (event: ProgressEvent) => {
                const total = event.lengthComputable ? event.total : 0;
                onProgress({
                    loaded: event.loaded,
                    total,
                    fraction: total > 0 ? Math.min(1, event.loaded / total) : 0,
                });
            };
        }

        xhr.onload = () => {
            cleanup();
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(xhr.responseText) as unknown;
            } catch {
                /* a non-JSON body falls through to the status-based message */
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                const accepted = parsed as TranscriptionAccepted | null;
                if (accepted?.id) {
                    resolve(accepted);
                } else {
                    reject(new ApiError('The server accepted the upload but did not return a note.', {
                        status: xhr.status,
                        body: parsed,
                    }));
                }
                return;
            }
            const message =
                (parsed as { error?: string } | null)?.error ||
                (xhr.status === 0 ? 'The upload was interrupted.' : `HTTP ${xhr.status}`);
            reject(new ApiError(message, { status: xhr.status, body: parsed }));
        };

        xhr.onerror = () => {
            cleanup();
            // status 0 with no body is the shape of a dropped connection. Say
            // that, because the recording is still safe on the device and the
            // only correct next step is to try again.
            reject(new ApiError('The connection dropped during the upload. Your recording is still on this device.'));
        };

        xhr.onabort = () => {
            cleanup();
            reject(new ApiError('Upload cancelled.'));
        };

        xhr.send(form);
    });
}

/**
 * How often to re-read a note while the server is still working on it.
 *
 * The pipeline takes minutes on a long meeting and there is nothing to stream,
 * so this is a poll — but a poll on a phone is a battery cost, so it is only
 * ever active while at least one note is 'processing'. React Query pauses it
 * when the app is backgrounded (focusManager is wired to AppState in
 * app/_layout.tsx), which is exactly the behaviour we want.
 */
export const PROCESSING_POLL_MS = 12_000;
