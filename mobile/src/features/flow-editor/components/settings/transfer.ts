/**
 * A routine as a file, pure: the name the exported file gets, and reading a
 * picked file back into the envelope POST /import takes (a routine exported
 * here or on the web: `{ format: 'beeflow.automation', automation }`, or a
 * bare `{ automation }`). The server checks the format and the definition
 * itself; this only refuses what is not a JSON object at all, so a wrong
 * file is named on the phone instead of costing a rate-limited request.
 */

/** "Invoice reminders.beeflow.json" — letters, digits, spaces, dashes and underscores only. */
export function exportFileName(title: string | null | undefined): string {
    const safe = (title || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return `${safe || 'Routine'}.beeflow.json`;
}

export type ParsedImport = { ok: true; envelope: Record<string, unknown> } | { ok: false; reason: 'empty' | 'not_json' | 'not_object' };

export function parseImportFile(text: string | null | undefined): ParsedImport {
    const trimmed = (text || '').replace(/^﻿/, '').trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return { ok: false, reason: 'not_json' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not_object' };
    return { ok: true, envelope: value as Record<string, unknown> };
}

/** The envelope as the file's text: readable, as the web's download is. */
export function exportFileText(envelope: Record<string, unknown>): string {
    return `${JSON.stringify(envelope, null, 2)}\n`;
}
