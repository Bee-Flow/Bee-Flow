/**
 * One source's documents — the port of the web's KnowledgeStudio
 * SourceDetail.jsx logic (its filter chips, `isPending` and `statusOfDoc`),
 * pinned by sourceDocuments.lockstep.test.ts.
 *
 * The status is the point of that view: before the source model a file that
 * failed left no row at all, so "38 files" quietly became 36. Each row says
 * whether it was processed, shielded (personal data replaced before it
 * entered the base), skipped, failed or a duplicate.
 */

import type { IconName, Tone } from '@/shared/ui';

import type { KbDocument, KbDocumentsResponse, KbSource } from './types';

/** The web's page size for one source's documents. */
export const SOURCE_DOC_PAGE = 50;

export type SourceDocFilter = 'all' | 'processed' | 'skipped' | 'pii';

/** The query the route reads for a chip and a search term (docFilters.js vocabulary). */
export function sourceDocParams(filter: SourceDocFilter, q: string): Record<string, string> {
    const params: Record<string, string> = {};
    if (filter === 'processed') params.status = 'processed,redacted';
    if (filter === 'skipped') params.status = 'skipped,error';
    if (filter === 'pii') params.pii = 'found';
    const term = q.trim();
    if (term) params.q = term;
    return params;
}

/** The chips' counts, from the source's own counters (mapSourceForApi). */
export function sourceDocCounts(source: KbSource): Record<SourceDocFilter, number> {
    return {
        all: source.documentCount,
        processed: source.processedCount + source.redactedCount,
        skipped: source.skippedCount + source.errorCount,
        pii: source.piiFoundCount,
    };
}

/**
 * A row still being worked on. The upload route parks a new row as `skipped`
 * with "Queued for processing" (`processing` is not a documents.status value),
 * so the REASON is what says it is pending.
 */
export function isPendingDoc(doc: Pick<KbDocument, 'status' | 'status_reason'>): boolean {
    return doc.status === 'skipped' && /queued/i.test(doc.status_reason ?? '');
}

export interface DocStatus {
    icon: IconName;
    tone: Tone;
    key: string;
    en: string;
}

/** Status → glyph, tone and words. Null when an older server did not say. */
export function docStatusOf(doc: Pick<KbDocument, 'status' | 'status_reason'>): DocStatus | null {
    if (isPendingDoc(doc)) return { icon: 'Loader', tone: 'neutral', key: 'knowledge.docs.status_processing', en: 'processing' };
    switch (doc.status) {
        case 'redacted':
            return { icon: 'ShieldCheck', tone: 'info', key: 'knowledge.docs.status_redacted', en: 'shielded' };
        case 'skipped':
            return { icon: 'TriangleAlert', tone: 'warning', key: 'knowledge.docs.status_skipped', en: 'skipped' };
        case 'error':
            return { icon: 'TriangleAlert', tone: 'error', key: 'knowledge.docs.status_error', en: 'failed' };
        case 'duplicate':
            return { icon: 'Check', tone: 'neutral', key: 'knowledge.docs.status_duplicate', en: 'duplicate' };
        case 'processed':
            return { icon: 'Check', tone: 'success', key: 'knowledge.docs.status_processed', en: 'processed' };
        default:
            return null;
    }
}

/** Some rows were stored without a personal-data check (the checker was down, or the file too large). */
export function hasUnscanned(docs: readonly Pick<KbDocument, 'status' | 'pii_status'>[]): boolean {
    return docs.some((d) => d.pii_status === 'unscanned' && d.status !== 'skipped');
}

/** Where the next page starts, or undefined when this one reached the total. */
export function nextDocOffset(page: Pick<KbDocumentsResponse, 'documents' | 'offset' | 'total'>): number | undefined {
    const next = page.offset + page.documents.length;
    return page.documents.length > 0 && next < page.total ? next : undefined;
}
