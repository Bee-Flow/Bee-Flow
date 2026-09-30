/**
 * Where a generated file is fetched from, and what it is called when saved.
 *
 * The server's own paths (`/api/storage/…`) need the session's headers; a
 * link to anywhere else must never be sent them — that would hand a third
 * party this person's token. `imageSource` in shared/markdown draws exactly
 * that line for pictures, and audio and video use the same one.
 */

import { imageSource, type ImageSource } from '@/shared/markdown';

import type { AudioFile, GeneratedFile, VideoFile } from './types';

export function mediaSource(
    file: Pick<AudioFile | VideoFile, 'url' | 'mimeType'>,
    serverUrl: string | null,
    headers: Record<string, string>,
): ImageSource | null {
    return imageSource({ url: file.url, mimeType: file.mimeType }, serverUrl, headers);
}

/** Whether a source is this workspace's own (it carries the session headers). */
export function isOwnServer(source: ImageSource): boolean {
    return Boolean(source.headers && Object.keys(source.headers).length > 0);
}

const EXTENSION: Readonly<Record<string, string>> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
};

/** The name a download is saved under: the URL's own file name, else `<stem>.<ext>`. */
export function mediaFileName(url: string, mimeType: string, stem: string): string {
    const last = url.split('?')[0]?.split('/').pop() ?? '';
    if (/\.[a-z0-9]{2,5}$/i.test(last)) return decodeURIComponent(last);
    return `${stem}.${EXTENSION[mimeType] ?? 'bin'}`;
}

/** "12 slides · 1.4 MB · /Decks/q3.pptx" — what is known about a built file (GeneratedMedia.jsx). */
export function fileMeta(file: GeneratedFile, slides: (count: number) => string): string {
    const n = Number(file.size);
    const size = n > 0 ? (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : '';
    return [file.slideCount ? slides(file.slideCount) : null, size || null, file.path || null].filter(Boolean).join(' · ');
}

/** A deck by kind or by name. */
export function isDeck(file: GeneratedFile): boolean {
    return file.kind === 'presentation' || /\.pptx$/i.test(file.name ?? '');
}

/** `83.4` → `'1:23'`. */
export function formatClock(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
