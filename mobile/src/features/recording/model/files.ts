/**
 * Where recordings live on the phone until the server has them.
 *
 * Always the DOCUMENT directory, never the cache: Android evicts the cache
 * under storage pressure, and a long meeting is exactly the kind of large,
 * long-lived file it goes after first. Every move here falls back to the
 * ORIGINAL location on failure — a file left in the cache is a small risk, a
 * file lost because we threw mid-move is a lost meeting.
 */

import { Directory, File, Paths } from 'expo-file-system';

/** Where finished recordings wait for their upload. */
export const RECORDINGS_DIRNAME = 'recordings';

export interface CapturedAudio {
    uri: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number;
}

/**
 * The type the upload declares, by the file's own extension.
 *
 * Android records AAC in ADTS (`.aac`, see useRecorder); anything else from
 * expo-audio is MPEG-4 (`.m4a`). `audio/m4a` is not a registered type, and
 * multer's filter checks `audio/*` or a known extension — `audio/mp4` and
 * `audio/aac` satisfy both readings.
 */
const MIME_BY_EXTENSION: Record<string, string> = { '.aac': 'audio/aac', '.m4a': 'audio/mp4' };

/** `.aac` for `file:///…/recording-1234.aac`; `.m4a` when there is none. */
export function extensionOf(uri: string): string {
    return /(\.[a-z0-9]+)$/i.exec(uri)?.[1]?.toLowerCase() ?? '.m4a';
}

export function mimeTypeFor(uri: string): string {
    return MIME_BY_EXTENSION[extensionOf(uri)] ?? 'audio/mp4';
}

function recordingsDir(): Directory {
    const dir = new Directory(Paths.document, RECORDINGS_DIRNAME);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
}

/** "Meeting 2026-08-29 14-05.aac" — what a person recognises in a file listing. */
function meetingFileName(stamp: Date, extension: string): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
        `Meeting ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
        ` ${pad(stamp.getHours())}-${pad(stamp.getMinutes())}${extension}`
    );
}

/**
 * Move a finished recording somewhere we control, under a readable name.
 *
 * expo-audio writes to a generated name; if the upload later fails and the
 * user goes looking, they find the meeting rather than a UUID. `moveSync`
 * rather than a copy: two copies of a 90 MB recording on a full phone is how
 * the SECOND one fails to write. `stamp` names the file after when it was
 * recorded, which for a recovered recording is not now.
 */
export function moveIntoLibrary(uri: string, durationSeconds: number, stamp: Date = new Date()): CapturedAudio {
    const source = new File(uri);
    const fileName = meetingFileName(stamp, extensionOf(uri));
    const mimeType = mimeTypeFor(uri);
    try {
        const destination = new File(recordingsDir(), fileName);
        source.moveSync(destination, { overwrite: true });
        return { uri: destination.uri, fileName, mimeType, sizeBytes: destination.size, durationSeconds };
    } catch {
        // The ORIGINAL is still there and still valid. Losing a meeting over a
        // filename is not an acceptable trade.
        const sizeBytes = source.exists ? source.size : 0;
        return { uri: source.uri, fileName, mimeType, sizeBytes, durationSeconds };
    }
}

/**
 * Move a picked file out of the cache directory, next to our own recordings,
 * so a queued import cannot evaporate. Prefixed with a timestamp so importing
 * the same file twice does not overwrite the copy still waiting to upload.
 */
export function moveIntoOutbox(uri: string, fileName: string): { uri: string; size: number } {
    const source = new File(uri);
    try {
        const destination = new File(recordingsDir(), `${Date.now()}-${fileName}`);
        source.moveSync(destination, { overwrite: true });
        return { uri: destination.uri, size: destination.size };
    } catch {
        return { uri: source.uri, size: source.exists ? source.size : 0 };
    }
}

/** Delete a file that may already be gone, or never have been written. */
export function deleteQuietly(uri: string): void {
    try {
        const file = new File(uri);
        if (file.exists) file.delete();
    } catch {
        /* already gone, or never written */
    }
}

/** False for a missing file and for a uri the file layer cannot even read. */
export function fileExists(uri: string): boolean {
    try {
        return new File(uri).exists;
    } catch {
        return false;
    }
}

/** Bytes on disk; 0 for a missing file or one the file layer cannot read. */
export function fileSize(uri: string): number {
    try {
        const file = new File(uri);
        return file.exists ? file.size : 0;
    } catch {
        return 0;
    }
}
