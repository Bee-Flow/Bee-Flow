/**
 * The audio a chat transcription works on (integrations/transcriptionTools.js).
 *
 * Chat attachments come from the request body, so only three sources count:
 * inline data/content, a storage key under the caller's own prefix, and a
 * URL fetched through the public-target guard (safeFetch). A local file path
 * in an attachment is never read; the upload routes pass theirs as
 * args.filePath instead. A refusal is thrown as the user-facing sentence.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { warn: (...args: unknown[]) => void };

type Attachment = {
    name?: string; filename?: string; type?: string;
    data?: unknown; content?: unknown; storageKey?: unknown; url?: unknown;
};

const NO_AUDIO = 'No audio file found. Please upload an audio file (MP3, WAV, M4A, OGG, WEBM, FLAC) as an attachment to your message.';
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg'];

/**
 * Resolve the active audio attachment from the context.
 * Returns { audioData, audioFileName } or throws an error string.
 */
export async function resolveAudioAttachment(context: { attachments?: Attachment[]; userId?: string }): Promise<{ audioData: Buffer; audioFileName: string }> {
    const { attachments } = context;
    if (!attachments || attachments.length === 0) throw NO_AUDIO;

    const audioAttachment = attachments.find((a) => {
        const ext = (a.name || a.filename || '').toLowerCase();
        return AUDIO_EXTENSIONS.some((e) => ext.endsWith(e)) || (typeof a.type === 'string' && a.type.startsWith('audio/'));
    });
    if (!audioAttachment) throw NO_AUDIO;

    const audioFileName = audioAttachment.name || audioAttachment.filename || 'audio.mp3';
    let audioData: Buffer | null = null;

    const raw = audioAttachment.data || audioAttachment.content;
    if (raw) {
        audioData = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'base64');
    } else if (typeof audioAttachment.storageKey === 'string' && audioAttachment.storageKey) {
        audioData = await readOwnStoredAudio(audioAttachment.storageKey, context.userId);
    } else if (typeof audioAttachment.url === 'string' && audioAttachment.url) {
        try {
            const { safeFetch } = nodeRequire('../../core/http/ssrfGuard.js') as { safeFetch: (url: string) => Promise<Response> };
            const resp = await safeFetch(audioAttachment.url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            audioData = Buffer.from(await resp.arrayBuffer());
        } catch (fetchErr) {
            log.warn(`[Transcription] audio download refused or failed: ${(fetchErr as Error).message}`);
            throw 'Could not download the audio file. Please upload it as an attachment instead.';
        }
    }

    if (!audioData) throw 'Could not read audio data from the attachment. Please try re-uploading the file.';
    return { audioData, audioFileName };
}

/** Read an uploaded file by storage key, only under the caller's own prefix. */
async function readOwnStoredAudio(key: string, userId: string | undefined): Promise<Buffer> {
    const prefix = userId ? `users/${userId}/` : null;
    const segments = key.split('/');
    if (!prefix || !key.startsWith(prefix) || segments.some((seg) => seg === '..' || seg === '.' || seg === '')) {
        throw 'Could not read the audio file. Please upload it again.';
    }
    try {
        const storageStore = nodeRequire('../../stores/storageStore.js') as {
            streamFile: (key: string) => Promise<{ stream: AsyncIterable<Buffer | string> }>;
        };
        const { stream } = await storageStore.streamFile(key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks);
    } catch (readErr) {
        log.warn(`[Transcription] stored audio read failed: ${(readErr as Error).message}`);
        throw 'Could not read the audio file. Please upload it again.';
    }
}

/** A file name safe inside a temp path: no directory part, only letters, digits, dot, dash and underscore. */
export function tempSafeName(name: unknown): string {
    const base = path.basename(String(name || '')).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
    return base.slice(-120) || 'audio';
}
