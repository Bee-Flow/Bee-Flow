/**
 * The plain-text pieces of a citation chip that other surfaces reuse too (the
 * sources panel, the chip row's closed chips). Kept out of CitationChips.jsx so
 * that file exports components and render helpers only.
 */
import { nOf } from '../../components/admin/Studio/KnowledgeStudio/plural';

type Translate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

/**
 * The day the cited thing HAPPENED — a meeting's own date, not the day it was
 * ingested. Anything unparseable is left out rather than shown as "Invalid
 * Date", which is the one label worse than no label.
 *
 * No year: a citation sits beside an answer about the present, and a year
 * spends a third of a narrow chip on the part nobody was unsure about.
 */
export function whenLabel(source: { occurredAt?: unknown } | null | undefined): string | null {
    const raw = source?.occurredAt;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) return null;
    return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * How many passages of one document a chip stands for, when it is more than
 * one; otherwise 0. Set by the chip row's grouping (answerChips.js, BFSF-352).
 */
export function passageCountOf(source: { passageCount?: unknown } | null | undefined): number {
    const n = Number(source?.passageCount);
    return Number.isInteger(n) && n > 1 ? n : 0;
}

/** "3 passages from this document", or null for a chip that folds nothing. */
export function passagesNote(source: { passageCount?: unknown } | null | undefined, tt: Translate): string | null {
    const count = passageCountOf(source);
    if (!count) return null;
    return nOf(tt, 'chat.citation_passages', count,
        '1 passage from this document', '{count} passages from this document');
}
