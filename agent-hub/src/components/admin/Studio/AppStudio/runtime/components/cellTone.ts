import { ROLE_COLORS, roleTextColor } from '../styleResolver';
import type { CSSProperties } from 'react';
import type { CellColumn, CellRow, ToneEntry } from './cellValue.types';

/** The same role palette, indexable by a tone name taken from the definition. */
export const ROLE_HEX: Record<string, string> = ROLE_COLORS;
/** Formats whose natural home is the right edge of the column. */
const NUMERIC_FORMATS = new Set<string | undefined>(['number', 'currency', 'percent', 'progress']);

/**
 * The resolved text alignment for a column.
 *
 * 'auto' (the default) right-aligns numerics and left-aligns everything else —
 * a column of figures that does not line up on its last digit is the clearest
 * single tell that a table was not designed. An explicit align always wins.
 */
export function alignFor(col: CellColumn | null | undefined): string {
    const explicit = col && col.align;
    if (explicit === 'left' || explicit === 'right' || explicit === 'center') return explicit;
    return NUMERIC_FORMATS.has(col?.format) ? 'right' : 'left';
}

export const ALIGN_CLASS: Record<string, string> = { left: 'text-left', right: 'text-right', center: 'text-center' };

export function isHttpUrl(value: unknown): boolean {
    const v = String(value || '').trim().toLowerCase();
    return v.startsWith('https://') || v.startsWith('http://');
}

/**
 * The tone for one cell, from the column's own configuration.
 *
 * `toneMap` is the author naming tones value by value (the shape `list` and
 * `kanban` already use). `toneFrom` names a SIBLING column whose value IS the
 * tone — which is what finally uses the `color` every config table in a
 * template already stores next to its rows, and what stopped every status pill
 * on every screen from being the same grey.
 */
export function toneForCell({ col, row, value }: { col: CellColumn | null | undefined; row: CellRow | null; value?: unknown }): string | null {
    if (!col) return null;
    const map = Array.isArray(col.toneMap) ? col.toneMap : null;
    if (col.toneFrom && row && typeof row === 'object') {
        const raw = row[col.toneFrom];
        if (raw != null && raw !== '') {
            // The sibling's value goes through the column's toneMap first, the
            // way subtextToneFor already did: a status column holds "open",
            // not "warning", and mapping it is the only way that status can
            // colour a cell in another column. A value the map does not name
            // is taken as a tone name itself - the config-table case.
            const hit = map ? map.find((m) => m && String(m.value) === String(raw)) : null;
            if (hit && hit.tone) return hit.tone;
            return String(raw);
        }
    }
    if (!map || value == null) return null;
    const hit = map.find((m) => m && String(m.value) === String(value));
    return hit ? (hit.tone || null) : null;
}

/** The label for one cell — a toneMap entry may relabel the stored value. */
export function labelForCell({ col, value }: { col: CellColumn | null | undefined; value: unknown }): unknown {
    const map = col && Array.isArray(col.toneMap) ? col.toneMap : null;
    if (!map || value == null) return value;
    const hit = map.find((m) => m && String(m.value) === String(value));
    return hit && hit.label != null ? hit.label : value;
}
/**
 * The tone for a cell's SUBTEXT line: `subtextToneFrom` names a sibling whose
 * value maps through the column's toneMap (value→tone), or is a tone name
 * itself. Null means the default muted subtext.
 */
export function subtextToneFor(col: CellColumn | null | undefined, row: CellRow | null): string | null {
    const key = col?.subtextToneFrom;
    if (!key || !row || typeof row !== 'object') return null;
    const raw = row[key];
    if (raw == null || raw === '') return null;
    const map = Array.isArray(col?.toneMap) ? col?.toneMap as ToneEntry[] : null;
    const hit = map ? map.find((m) => m && String(m.value) === String(raw)) : null;
    if (hit && hit.tone) return hit.tone;
    return ROLE_HEX[String(raw)] ? String(raw) : null;
}
/**
 * A text or number cell has no pill to carry a tone, so the tone colours the
 * text itself. Only a tone the column actually resolves - through toneFrom or
 * a toneMap hit - changes anything; a column without either renders exactly as
 * before, which is every text column that exists today.
 */
export function textToneStyle(col: CellColumn | null, row: CellRow | null, value: unknown): CSSProperties | undefined {
    if (!col || (!col.toneFrom && !Array.isArray(col.toneMap))) return undefined;
    const tone = toneForCell({ col, row, value });
    if (!tone || tone === 'neutral' || !ROLE_HEX[tone]) return undefined;
    return { color: roleTextColor(tone) };
}
