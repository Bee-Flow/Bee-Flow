/**
 * Small rules the import screen shares across its three sources.
 */

import { formatBytes } from '@/shared/lib/bytes';
import { absoluteDate } from '@/shared/lib/display';

/** The note's title from a file name, as the web does: the name without its extension. */
export function titleFromFileName(name: string): string {
    const bare = name.replace(/\.[^/.]+$/, '').trim();
    return bare || 'meeting';
}

/** "12.4 MB · 3 Sep 2026", leaving out whatever is unknown. */
export function fileFacts(size: number | null, lastModified: string | null): string {
    return [size !== null ? formatBytes(size) : '', lastModified ? absoluteDate(lastModified) : '']
        .filter(Boolean)
        .join(' · ');
}

/** The folder the web browses by default for loose audio files. */
export const DEFAULT_AUDIO_FOLDER = '/Recordings';

/** Nextcloud paths are absolute; a typed "Recordings" means "/Recordings". */
export function normaliseFolder(input: string): string {
    const trimmed = input.trim().replace(/\/+$/, '');
    if (!trimmed) return DEFAULT_AUDIO_FOLDER;
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
