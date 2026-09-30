/**
 * Download a server file into the app's cache, on the app's own session.
 *
 * Why not hand the URL to the native player or downloader: expo-audio and
 * expo-file-system's `File.downloadFileAsync` each build a bare OkHttpClient,
 * without the cookie jar the rest of the app shares (see client.ts). A
 * password or OPAQUE session lives in that jar, so a native request would
 * reach the server signed out and get a 401 where the person expected their
 * recording. `expo/fetch` runs on the shared client, so the bytes are fetched
 * here and the file on disk is what the native side gets.
 *
 * The body is STREAMED to disk chunk by chunk when the runtime exposes a
 * reader, so an hour of audio never sits in memory as one buffer; a runtime
 * without one falls back to reading the whole body.
 *
 * The body goes into `<name>.part` and is moved to its name only once it is
 * complete. A download cut short (the screen left, the app killed) leaves at
 * most a `.part`, which `reuse` never picks up.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';

import { authHeaders, errorFromResponse } from './client';
import { apiUrl } from './server';
import { sessionCacheDir } from './sessionCache';

/** Strip anything Android's file layer would object to. */
export function safeFileName(name: string, fallback = 'download'): string {
    const cleaned = name.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
    return cleaned.length ? cleaned.slice(0, 120) : fallback;
}

export interface DownloadOptions {
    signal?: AbortSignal;
    /** Reuse a cached copy of the same name instead of downloading again. */
    reuse?: boolean;
    /** POST for a file the server renders on request (a webpage's PDF export); such a route takes no body. */
    method?: 'GET' | 'POST';
    /** Keep the file in the session's folder, which sign-out wipes (see sessionCache.ts). */
    sessionScoped?: boolean;
}

export interface DownloadedFile {
    uri: string;
    /** The server's Content-Type, or null when it sent none. */
    contentType: string | null;
}

type BodyReader = { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
type StreamingBody = { getReader?: () => BodyReader } | null | undefined;

/** Write the response body into `file`, chunk by chunk where possible. */
async function writeBody(
    file: File,
    res: { body?: unknown; arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<void> {
    const reader = (res.body as StreamingBody)?.getReader?.();
    if (!reader) {
        file.write(new Uint8Array(await res.arrayBuffer()));
        return;
    }
    const handle = file.open();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) handle.writeBytes(value);
        }
    } finally {
        handle.close();
    }
}

export async function downloadToCache(
    path: string,
    fileName: string,
    opts: DownloadOptions = {},
): Promise<DownloadedFile> {
    const dir = opts.sessionScoped ? sessionCacheDir() : Paths.cache;
    const name = safeFileName(fileName);
    const file = new File(dir, name);
    if (opts.reuse && file.exists && (file.size ?? 0) > 0) return { uri: file.uri, contentType: null };

    const res = await expoFetch(apiUrl(path), {
        method: opts.method ?? 'GET',
        credentials: 'include',
        headers: authHeaders(),
        signal: opts.signal,
    });
    // A 401 goes to the lock screen, as it would from any other request.
    if (!res.ok) throw await errorFromResponse(path, res);

    const part = new File(dir, `${name}.part`);
    part.create({ overwrite: true, intermediates: true });
    try {
        await writeBody(part, res);
    } catch (err) {
        if (part.exists) part.delete();
        throw err;
    }
    if (file.exists) file.delete();
    part.moveSync(file);
    return { uri: file.uri, contentType: res.headers.get('content-type') };
}
