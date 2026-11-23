/**
 * The words of a source's document list (SourceDetail): the header's file
 * count and what a row says it took from a document, a failure in plain words
 * with the raw ingest error kept for the tooltip.
 */
import type { TranslateFn } from '@/hooks/useTranslation';
import type { KbDocument } from './knowledgeApi';

/** "1 file · 0 processed" / "38 files · 36 processed" in the header. */
export function docPill(t: TranslateFn, counts: Record<string, unknown>): string {
    const total = Number(counts.documentCount) || 0;
    const params = { total, done: (Number(counts.processedCount) || 0) + (Number(counts.redactedCount) || 0) };
    return total === 1
        ? t('knowledge.doc_pill_one', '{total} file · {done} processed', params)
        : t('knowledge.doc_pill', '{total} files · {done} processed', params);
}

/** The "What the AI took from it" cell: the summary, else why it was skipped or failed. */
export function takenFrom(t: TranslateFn, doc: KbDocument): string {
    if (doc.extract_summary) return doc.extract_summary;
    if (doc.status === 'error') return failureText(t, doc.status_reason);
    return doc.status_reason || '';
}

/** The raw ingest error of a failed document, for its tooltip. */
export function failureDetail(doc: KbDocument): string | undefined {
    return doc.status === 'error' && doc.status_reason ? doc.status_reason : undefined;
}

/** Why a document failed, as a sentence that says what to do; the raw reason is its tooltip. */
export function failureText(t: TranslateFn, reason: string | null | undefined): string {
    if (/no chunks/i.test(String(reason || ''))) {
        return t('knowledge.docs.error_too_little_text', 'Too little text to search. Add a longer text instead.');
    }
    return t('knowledge.docs.error_generic', 'This could not be added. Try again, or remove it.');
}
