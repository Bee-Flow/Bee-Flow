/**
 * The meeting upload: `POST /api/transcriptions`, multipart, with progress.
 *
 * The file goes under the field name `audio` (multer's `upload.single('audio')`),
 * is capped at 500 MB, and must have one of ACCEPTED_AUDIO_EXTENSIONS or any
 * `audio/*` MIME type. Getting either wrong is a 400 from the fileFilter that
 * reads like a server error. The route answers 202 with a `processing` note the
 * moment the bytes have landed and finishes the pipeline in the background.
 */

import { ApiError } from '@/core/api/client';
import { uploadFile, type UploadProgress, type UploadTarget } from '@/core/api/xhrUpload';

import { readAccepted } from './readers';
import type { CaptureSettings, TranscriptionAccepted } from '../model/types';

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

export function isAcceptedAudioName(name: string): boolean {
    const lower = name.toLowerCase();
    return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface UploadInput {
    uri: string;
    fileName: string;
    mimeType: string;
    captureMode: 'recording' | 'upload';
    settings: CaptureSettings;
}

interface UploadOptions {
    onProgress?: (e: UploadProgress) => void;
    signal?: AbortSignal;
}

/** The text parts beside the audio, snake_case on the wire: they are read straight off `req.body`. */
function textParts({ captureMode, settings }: UploadInput): Record<string, string> {
    const parts: Record<string, string> = { capture_mode: captureMode, language: settings.language, title: settings.title };
    if (settings.contextTerms.trim()) parts.context_terms = settings.contextTerms.trim();
    if (settings.attendees.trim()) parts.attendees = settings.attendees.trim();
    const speakers = settings.numSpeakers.trim();
    if (speakers) parts.num_speakers = speakers;
    // `provider` is deliberately never sent. The engine decides which third
    // party the meeting audio reaches, and the admin's server-side default is
    // the only answer this client has any business giving.
    return parts;
}

/**
 * POST the audio, with progress, through the shared multipart uploader
 * (core/api/xhrUpload): a meeting upload is the one request a person sits and
 * watches — hundreds of megabytes over a hotel wifi, where a spinner with no
 * number is indistinguishable from a hang. Streamed from disk, so a 500 MB
 * recording never has to exist in JS memory. Errors are ApiErrors, so the 402
 * that means "plan limit" reads as one rather than as a crash.
 */
export async function uploadRecording(input: UploadInput, opts: UploadOptions = {}): Promise<TranscriptionAccepted> {
    const target: UploadTarget = { path: '/api/transcriptions', field: 'audio', maxBytes: MAX_UPLOAD_BYTES, extra: textParts(input) };
    // Size 0: the recorder does not know it, so the cap is the server's to enforce.
    const body = await uploadFile<unknown>(target, { uri: input.uri, name: input.fileName, mimeType: input.mimeType, size: 0 }, opts);
    const accepted = readAccepted(body);
    if (accepted?.id) return accepted;
    throw new ApiError('The server accepted the upload but did not return a note.', { body });
}
