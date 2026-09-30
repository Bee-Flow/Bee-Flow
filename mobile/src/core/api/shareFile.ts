/**
 * Handing a file to the rest of the phone.
 *
 * Two rules behind everything in this file:
 *
 * 1. NEVER hand an api path to Linking. Every document endpoint on this server
 *    is behind the session cookie, and an external browser (or a PDF viewer
 *    opening a https:// url) has a different cookie jar — it would be sent to
 *    the login page and the person would conclude the file was gone. So the
 *    bytes are fetched on the app's own session by downloadFile.ts, written
 *    to the cache, and shared from disk.
 *
 * 2. Do not pretend to render a PDF. This app has no WebView and no PDF
 *    engine, and a blank grey box with the word "preview" on it is worse than
 *    an honest "Open with…" that hands the file to something that can.
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { downloadToCache, safeFileName } from './downloadFile';

/**
 * Download a server file into the cache and open the Android share sheet on
 * it, which is where "open with", "save to Drive" and "send" all live.
 *
 * `method: 'POST'` is for a file the server renders on request (a webpage's
 * PDF export) rather than one it already has; such a route takes no body.
 *
 * Returns the local uri so a caller can reuse it; the file is left in the
 * cache directory, which the OS reclaims when it needs the space. The
 * rendered-document routes answer 404 with a real explanation ("It may have
 * expired"), which the thrown error carries verbatim.
 */
export async function shareServerFile(
    path: string,
    fileName: string,
    mimeType = 'application/octet-stream',
    options: { method?: 'GET' | 'POST' } = {},
): Promise<string> {
    const { uri } = await downloadToCache(path, fileName, { method: options.method });
    if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType, dialogTitle: fileName, UTI: mimeType });
    }
    return uri;
}

/**
 * Share text the app already has — a source's extracted content, a document's
 * reassembled chunks — as a real file rather than as a clipboard blob, so it
 * can land in Drive or an email like anything else.
 */
export async function shareText(text: string, fileName: string): Promise<void> {
    const name = /\.[a-z0-9]{1,5}$/i.test(fileName) ? fileName : `${fileName}.txt`;
    const file = new File(Paths.cache, safeFileName(name, 'document'));
    if (file.exists) file.delete();
    file.create({ overwrite: true, intermediates: true });
    file.write(text);
    if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: name });
    }
}
