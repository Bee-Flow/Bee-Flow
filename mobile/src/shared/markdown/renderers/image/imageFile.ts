/**
 * An image on screen, as a file the rest of the phone can take: the share
 * sheet, or a folder the person picks (the web's "Download").
 *
 * No second download. expo-image already holds what it drew in its disk
 * cache, fetched on the app's own session (links.ts imageSource), and
 * `Image.getCachePathAsync` hands that file over. An inline `data:` image
 * never reaches that cache, so its bytes are written to the app's cache
 * directory instead.
 *
 * Saving goes through Android's folder picker (the Storage Access
 * Framework), which needs no storage permission and no media-library module:
 * the person chooses where the picture lands, as a browser's Save dialog does.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

/** `data:image/png;base64,…` → its type and payload; null for anything else. */
export function readDataUri(uri: string): { mime: string; base64: string } | null {
    const match = /^data:([\w/+.-]+);base64,/.exec(uri);
    return match ? { mime: match[1] as string, base64: uri.slice(match[0].length) } : null;
}

function safeDecode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

/** A file name for the picture: its own when the URL has one, else the web's `ai-image-<time>.png`. */
export function imageFileName(uri: string, now: number = Date.now()): string {
    const data = readDataUri(uri);
    if (data) {
        const ext = EXTENSION_BY_MIME[data.mime] ?? data.mime.split('/')[1] ?? 'png';
        return `ai-image-${now}.${ext}`;
    }
    const path = uri.split(/[?#]/, 1)[0] ?? '';
    const last = safeDecode(path.slice(path.lastIndexOf('/') + 1));
    const ext = last.includes('.') ? last.slice(last.lastIndexOf('.') + 1).toLowerCase() : '';
    return MIME_BY_EXTENSION[ext] ? last.replace(/[^\w.\- ]/g, '_') : `ai-image-${now}.png`;
}

export function imageMimeType(fileName: string): string {
    const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
    return MIME_BY_EXTENSION[ext] ?? 'image/png';
}

/** The picture as a local file, or null when it is not on the phone (never drawn). */
export async function localImage(uri: string, name: string): Promise<File | null> {
    const data = readDataUri(uri);
    if (data) {
        const file = new File(Paths.cache, name);
        if (file.exists) file.delete();
        file.create({ overwrite: true, intermediates: true });
        file.write(data.base64, { encoding: 'base64' });
        return file;
    }
    const cached = await Image.getCachePathAsync(uri);
    if (!cached) return null;
    return new File(cached.startsWith('file://') ? cached : `file://${cached}`);
}

export type ImageActionResult = 'done' | 'cancelled' | 'unavailable';

export async function shareImage(uri: string): Promise<ImageActionResult> {
    const name = imageFileName(uri);
    const file = await localImage(uri, name);
    if (!file || !(await Sharing.isAvailableAsync())) return 'unavailable';
    await Sharing.shareAsync(file.uri, { mimeType: imageMimeType(name), dialogTitle: name });
    return 'done';
}

export async function saveImage(uri: string): Promise<ImageActionResult> {
    const name = imageFileName(uri);
    const file = await localImage(uri, name);
    if (!file) return 'unavailable';
    let folder: Directory;
    try {
        folder = await Directory.pickDirectoryAsync();
    } catch {
        return 'cancelled';
    }
    const target = folder.createFile(name, imageMimeType(name));
    target.write(await file.bytes());
    return 'done';
}
