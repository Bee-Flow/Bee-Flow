/**
 * What a refused source means, in the web's words (AddSourcePanel messageFor):
 * a plan cap says its number, a rejected address says it cannot be fetched
 * from here, a kind that has not landed says so, and a delete that could not
 * clear every document says the source was kept on purpose.
 */

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import type { TranslateFn } from '@/core/i18n';

export function sourceErrorMessage(t: TranslateFn, e: unknown): string {
    const code = e instanceof ApiError ? e.code : undefined;
    const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : {};
    switch (code) {
        case 'source_limit_reached':
            return t('knowledge.err_source_limit', 'This knowledge base already has the most sources your plan allows ({limit}).', {
                limit: typeof body.limit === 'number' ? body.limit : '',
            });
        case 'url_rejected': return t('knowledge.err_url_rejected', 'That address cannot be fetched from here.');
        case 'fetch_failed': return t('knowledge.err_fetch_failed', 'That page could not be reached.');
        case 'kind_not_available': return t('knowledge.err_kind', 'That kind of source is not available yet.');
        case 'purge_incomplete':
            return t('mobile.knowledge.err_purge_incomplete', 'Some of its documents could not be removed, so the source was kept. Try deleting it again.');
        case 'text_too_long': return t('knowledge.err_text_too_long', 'That text is too long — split it into a few sources.');
        default: return describeError(e).message || t('knowledge.err_add_source', 'Could not add that source.');
    }
}
