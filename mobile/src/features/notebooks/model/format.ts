/** Presentation helpers for notebooks and their sources. */

import { translate } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import type { NotebookSource } from './types';

/**
 * Icon for a notebook source. The type strings are exactly the ones
 * routes/notebooks.js writes: its extension map produces
 * pdf | docx | xlsx | csv | text | file, and the other three routes add
 * url | meeting | gdrive.
 */
export function sourceIcon(type: string): IconName {
    switch (type) {
        case 'pdf':
            return 'FileText';
        case 'docx':
            return 'FileText';
        case 'xlsx':
        case 'csv':
            return 'LayoutGrid';
        case 'text':
            return 'TextAlignStart';
        case 'url':
            return 'Link';
        case 'meeting':
            return 'Mic';
        case 'gdrive':
        case 'onedrive':
            return 'Cloud';
        case 'image':
            return 'Image';
        default:
            return 'File';
    }
}

/** Still being extracted, chunked or embedded on the server's worker. */
export function isWorking(source: NotebookSource): boolean {
    return source.status === 'processing' || source.status === 'pending';
}

/**
 * The worker's stage word, in the web's words (NotebookSources.jsx): the
 * stages sourceIngestion.js writes are queued, extracting, fetching and
 * embedding; anything else is "Processing…".
 */
export function stageLabel(stage: string | null): string {
    switch (stage) {
        case 'queued':
            return translate('notebooks.stage_queued', 'Queued…');
        case 'extracting':
            return translate('notebooks.stage_extracting', 'Reading…');
        case 'fetching':
            return translate('notebooks.stage_fetching', 'Fetching…');
        case 'embedding':
            return translate('notebooks.stage_embedding', 'Indexing…');
        default:
            return translate('notebooks.stage_processing', 'Processing…');
    }
}

/**
 * The line under a source's name. `stage` is the worker's own progress word —
 * it beats a spinner that says nothing for forty seconds.
 */
export function sourceSubtitle(source: NotebookSource): string {
    if (source.status === 'error') return source.error || translate('notebooks.failed', 'Failed');
    if (isWorking(source)) return stageLabel(source.stage);
    if (source.wordCount > 0) {
        return translate('notebooks.n_words', '{count} words', { count: source.wordCount.toLocaleString() });
    }
    return typeof source.metadata.url === 'string' ? source.metadata.url : '';
}

/** How many sources are ready, in the web's words. */
export function readyLine(ready: number, total: number): string {
    if (total > 0 && ready === total) return translate('notebooks.all_n_sources_ready', 'All {count} sources ready', { count: total });
    return translate('notebooks.n_of_m_ready', '{ready} / {total} ready', { ready, total });
}

/** The notebook header's second line: what is ready, and what is still landing. */
export function sourcesLine(sources: NotebookSource[]): string {
    const ready = sources.filter((s) => s.status === 'ready').length;
    const working = sources.filter(isWorking).length;
    const line = readyLine(ready, sources.length);
    if (working === 0) return line;
    return `${line} · ${translate('notebooks.processing_sources', '{count} sources processing', { count: working })}`;
}
