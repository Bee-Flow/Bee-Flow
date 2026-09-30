/**
 * How a knowledge source reads: its kind's glyph and word, its state, and
 * what can still be done with it. The web's WebpageSources.jsx SOURCE_META,
 * plus the two Drive kinds the server can store (routes/webpages/sources.js
 * `/sources/drive`) that the web's table folds into "File".
 */

import { translate } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import type { SourceType, WebpageSource } from './buildTypes';
import type { StatusToken } from './format';

interface SourceMeta {
    icon: IconName;
    key: string;
    fallback: string;
}

const META: Record<SourceType, SourceMeta> = {
    pdf: { icon: 'FileText', key: 'mobile.webpages.source.type_pdf', fallback: 'PDF' },
    docx: { icon: 'FileText', key: 'mobile.webpages.source.type_word', fallback: 'Word' },
    xlsx: { icon: 'Table2', key: 'mobile.webpages.source.type_excel', fallback: 'Excel' },
    csv: { icon: 'Table2', key: 'mobile.webpages.source.type_csv', fallback: 'CSV' },
    text: { icon: 'FileText', key: 'mobile.webpages.source.type_text', fallback: 'Text' },
    url: { icon: 'Link', key: 'mobile.webpages.source.type_url', fallback: 'URL' },
    file: { icon: 'File', key: 'mobile.webpages.source.type_file', fallback: 'File' },
    gdrive: { icon: 'Cloud', key: 'mobile.webpages.source.type_gdrive', fallback: 'Google Drive' },
    onedrive: { icon: 'Cloud', key: 'mobile.webpages.source.type_onedrive', fallback: 'OneDrive' },
};

export function sourceIcon(source: WebpageSource): IconName {
    return META[source.type].icon;
}

export function sourceKindLabel(source: WebpageSource): string {
    const meta = META[source.type];
    return translate(meta.key, meta.fallback);
}

/**
 * A failed source can be read again only from what the server kept: the
 * address of a url source, or the uploaded file. Pasted text and a Drive
 * import were never stored, so the only way back is to add them again.
 */
export function canRetrySource(source: WebpageSource): boolean {
    return source.status === 'error' && (source.type === 'url' || source.storageKey !== null);
}

/** Cancelling only makes sense while the server is still reading it. */
export function canCancelSource(source: WebpageSource): boolean {
    return source.status === 'processing';
}

export function sourceStatus(source: WebpageSource): StatusToken {
    if (source.status === 'processing') {
        return { label: translate('mobile.webpages.source.processing', 'Processing…'), tone: 'warning' };
    }
    if (source.status === 'error') {
        return { label: translate('knowledge.failed', 'Failed'), tone: 'error' };
    }
    return { label: translate('mobile.webpages.source.ready', 'Ready'), tone: 'success' };
}

/** "1,204 words", or the error, or nothing while it is being read. */
export function sourceDetail(source: WebpageSource): string | undefined {
    if (source.status === 'error') return source.error ?? undefined;
    if (source.status !== 'ready') return undefined;
    return translate('mobile.webpages.source.words', '{count} words', {
        count: source.wordCount.toLocaleString(),
    });
}

/** True while any source is still being read, so the list keeps polling. */
export function anyProcessing(sources: readonly WebpageSource[] | undefined): boolean {
    return (sources ?? []).some((s) => s.status === 'processing');
}
