/**
 * Shapes the open webpage editor passes between its hooks. They mirror what
 * `webpagesApi.fetchWebpageBundle` returns and what the SSE events carry.
 */

import type { WebpageRow } from './webpagesWebpageRow.types';

export type { WebpageRow, WebpageSettings } from './webpagesWebpageRow.types';

/** The three primary slots every page has. */
export type PrimaryFile = 'html' | 'css' | 'js';

export interface PrimaryContent {
    html: string;
    css: string;
    js: string;
}

const PRIMARY_FILES: readonly PrimaryFile[] = ['html', 'css', 'js'];

export function isPrimaryFile(file: unknown): file is PrimaryFile {
    return file === 'html' || file === 'css' || file === 'js';
}

/** Metadata of one extra file in a multi-file project. */
export interface ExtraFileMeta {
    path: string;
    mimeType?: string;
    size?: number;
    isText?: boolean;
    [key: string]: unknown;
}

/** `extraContents[path]`: text content, or a data URL for a binary. */
export interface ExtraContent {
    mimeType?: string;
    isText: boolean;
    content?: string;
    dataUrl?: string;
}

export type ExtraContents = Record<string, ExtraContent>;

/** The fields of the row the editor may patch and report to the shell. */
export type WebpagePatch = Partial<WebpageRow>;

export type ContentSetter = (value: string) => void;
export type PrimarySetters = Record<PrimaryFile, ContentSetter>;
