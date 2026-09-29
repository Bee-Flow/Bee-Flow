/**
 * Small presentation helpers shared by every Library screen.
 *
 * They live here rather than in the UI kit because each one encodes something
 * about THIS domain — which server type strings exist, what a fused retrieval
 * score means — that a generic component has no business knowing.
 */

import type { Feather } from '@expo/vector-icons';

type FeatherName = keyof typeof Feather.glyphMap;

/**
 * Icon for a notebook source. The type strings are exactly the ones
 * routes/notebooks.js writes: its extension map produces
 * pdf | docx | xlsx | csv | text | file, and the other three routes add
 * url | meeting | gdrive.
 */
export function sourceIcon(type: string): FeatherName {
    switch (type) {
        case 'pdf':
            return 'file-text';
        case 'docx':
            return 'file-text';
        case 'xlsx':
        case 'csv':
            return 'grid';
        case 'text':
            return 'align-left';
        case 'url':
            return 'link';
        case 'meeting':
            return 'mic';
        case 'gdrive':
        case 'onedrive':
            return 'cloud';
        case 'image':
            return 'image';
        default:
            return 'file';
    }
}

/**
 * Icon for a knowledge-base document, keyed on `source_type` — set at ingest
 * time by kbIngestionHelpers: 'upload' for a file, 'text' for a snippet,
 * 'web' for a fetched page, 'email' for a mailbox sync.
 */
export function documentIcon(sourceType: string | null | undefined): FeatherName {
    switch (sourceType) {
        case 'upload':
            return 'file-text';
        case 'text':
            return 'align-left';
        case 'web':
            return 'globe';
        case 'email':
            return 'mail';
        default:
            return 'file';
    }
}

/** Guess a mime type from a file name, for pickers that do not report one. */
export function mimeTypeFor(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        doc: 'application/msword',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xls: 'application/vnd.ms-excel',
        csv: 'text/csv',
        txt: 'text/plain',
        md: 'text/markdown',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        heic: 'image/heic',
    };
    return map[ext] ?? 'application/octet-stream';
}

/**
 * A retrieval score as a share of the best hit in the same result set.
 *
 * The raw number is a reciprocal-rank fusion score (see searchLocally in
 * server/core/kb/localKBIngest.js), not a probability — printing "0.032" tells
 * nobody anything, and printing "3%" would be a lie. Relative strength within
 * one query is the only honest reading.
 */
export function relativeScore(score: number, best: number): number {
    if (!Number.isFinite(score) || !Number.isFinite(best) || best <= 0) return 0;
    return Math.max(0, Math.min(1, score / best));
}

/** Collapse whitespace so a chunk preview does not render as a ragged block. */
export function condense(text: string, max = 240): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** "3 sources · 1 200 words" — the notebook subtitle, built in one place. */
export function countLabel(parts: (string | null | undefined)[]): string {
    return parts.filter((p): p is string => Boolean(p && p.length)).join(' · ');
}
