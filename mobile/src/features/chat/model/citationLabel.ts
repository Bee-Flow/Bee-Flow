/**
 * How a citation names itself: "Handbook · p. 12", "Prices · rows 1–50",
 * "Widget A · Products", "Standup · 22 Jul" — the web's chipLabel and
 * chipTitle (agent-hub/src/pages/documents/notebook/CitationChips.jsx, with the pieces
 * it shares in citationText.ts; pinned by citationLabel.lockstep.test.ts).
 *
 * The page is the point of a citation — it can be checked — and it is often
 * absent: anything ingested before the chunker stamped pages has none, for
 * good. A chip without one simply says less; it never prints "p. ?".
 */

import type { TranslateFn } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';

import type { KbSource } from './types';

/**
 * A chip in the row under an answer: one DOCUMENT, standing for the
 * `passageCount` passages of it the answer cited when that is more than one
 * (the grouping is citationGroups.ts).
 */
export interface CitationChip extends KbSource {
    passageCount?: number;
}

/** How many passages a chip folds when more than one; otherwise 0 (the web's citationText.ts). */
export function passageCountOf(source: CitationChip | null | undefined): number {
    const n = Number(source?.passageCount);
    return Number.isInteger(n) && n > 1 ? n : 0;
}

/** "3 passages from this document", or null for a chip that folds nothing. */
export function passagesNote(source: CitationChip | null | undefined, t: TranslateFn): string | null {
    const count = passageCountOf(source);
    if (!count) return null;
    return nOf(t, 'chat.citation_passages', count, ['1 passage from this document', '{count} passages from this document']);
}

/** A whole number above zero, or null. */
function ordinal(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** "rows 1–50", or "row 7" for one row. Both ends or nothing. */
function rowsLabel(source: KbSource, t: TranslateFn): string | null {
    const from = ordinal(source.rowStart);
    const to = ordinal(source.rowEnd);
    if (from === null || to === null || to < from) return null;
    return from === to
        ? t('notebooks.row_short', 'row {n}', { n: from })
        : t('notebooks.rows_short', 'rows {from}–{to}', { from, to });
}

/** The day the cited thing happened (a meeting's own date), without a year. */
function whenLabel(source: KbSource): string | null {
    const raw = source.occurredAt;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) return null;
    return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The table a LIVE row comes from — only for a real row (`datatableId` + `rowId`). */
function tableLabel(source: KbSource): string | null {
    if (!source.datatableId || !source.rowId) return null;
    const name = typeof source.sourceName === 'string' ? source.sourceName.trim() : '';
    return name || null;
}

/**
 * A label in two halves: the title, and what places it (rows, table, page,
 * date). A chip that folds several passages stands for the document, so the
 * page and the rows of one passage are left out of it.
 */
function chipParts(source: CitationChip, index: number, t: TranslateFn): { title: string; meta: string } {
    const title = source.title || `${t('notebooks.source', 'Source')} ${index + 1}`;
    const folded = passageCountOf(source) > 0;
    const page = folded ? null : ordinal(source.page);
    const where =
        (folded ? null : rowsLabel(source, t)) || tableLabel(source) || (page ? t('notebooks.page_short', 'p. {n}', { n: page }) : null);
    return { title, meta: [where, whenLabel(source)].filter(Boolean).join(' · ') };
}

export function chipLabel(source: CitationChip, index: number, t: TranslateFn): string {
    const { title, meta } = chipParts(source, index, t);
    return meta ? `${title} · ${meta}` : title;
}

/** The label plus the heading the passage sits under — when the heading adds something. */
export function chipTitle(source: KbSource, label: string): string {
    const section = typeof source.section === 'string' ? source.section.trim() : '';
    if (!section || label.includes(section)) return label;
    return `${label} — ${section}`;
}
