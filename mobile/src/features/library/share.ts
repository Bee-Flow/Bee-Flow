/**
 * Handing a file to the rest of the phone.
 *
 * Two rules behind everything in this file:
 *
 * 1. NEVER hand an api path to Linking. Every document endpoint on this server
 *    is behind the session cookie, and an external browser (or a PDF viewer
 *    opening a https:// url) has a different cookie jar — it would be sent to
 *    the login page and the person would conclude the file was gone. So the
 *    bytes are fetched here, through `expo/fetch`, which on Android runs on
 *    the same OkHttp client and ForwardingCookieHandler as the rest of the app
 *    (see src/api/client.ts), written to the cache, and shared from disk.
 *
 * 2. Do not pretend to render a PDF. This app has no WebView and no PDF
 *    engine, and a blank grey box with the word "preview" on it is worse than
 *    an honest "Open with…" that hands the file to something that can.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { ApiError, authHeaders } from '../../api/client';
import { apiUrl } from '../../api/server';

/** Strip anything Android's file layer would object to. */
function safeName(name: string): string {
    const cleaned = name.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
    return cleaned.length ? cleaned.slice(0, 120) : 'document';
}

/**
 * Download a server file into the cache and open the Android share sheet on
 * it, which is where "open with", "save to Drive" and "send" all live.
 *
 * Returns the local uri so a caller can reuse it; the file is left in the
 * cache directory, which the OS reclaims when it needs the space.
 */
export async function shareServerFile(
    path: string,
    fileName: string,
    mimeType = 'application/octet-stream',
): Promise<string> {
    const res = await expoFetch(apiUrl(path), {
        credentials: 'include',
        headers: authHeaders(),
    });
    if (!res.ok) {
        // The rendered-document routes answer 404 with a real explanation
        // ("It may have expired") — worth surfacing verbatim.
        let parsed: unknown = null;
        try {
            parsed = await res.json();
        } catch {
            /* not JSON */
        }
        throw new ApiError(
            (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
            { status: res.status, body: parsed },
        );
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const file = new File(Paths.cache, safeName(fileName));
    if (file.exists) file.delete();
    file.create({ overwrite: true, intermediates: true });
    file.write(bytes);

    if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName, UTI: mimeType });
    }
    return file.uri;
}

/**
 * Share text the app already has — a source's extracted content, a document's
 * reassembled chunks — as a real file rather than as a clipboard blob, so it
 * can land in Drive or an email like anything else.
 */
export async function shareText(text: string, fileName: string): Promise<void> {
    const name = /\.[a-z0-9]{1,5}$/i.test(fileName) ? fileName : `${fileName}.txt`;
    const file = new File(Paths.cache, safeName(name));
    if (file.exists) file.delete();
    file.create({ overwrite: true, intermediates: true });
    file.write(text);
    if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: name });
    }
}
