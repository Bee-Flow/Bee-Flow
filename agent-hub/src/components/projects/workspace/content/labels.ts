// Words and numbers the content tabs show for an item: a document's type, a
// meeting's length and status, a file's size.

import type { TranslateFn } from '../../../../hooks/useTranslation';

/** The document types the server knows, in the words a person uses. */
export function docTypeLabel(t: TranslateFn, docType: string | null | undefined): string {
    switch (docType) {
        case 'presentation': return t('project_content.doc_type_presentation', 'Presentation');
        case 'invoice': return t('project_content.doc_type_invoice', 'Invoice');
        case 'quote': return t('project_content.doc_type_quote', 'Quote');
        case 'letter': return t('project_content.doc_type_letter', 'Letter');
        case 'report': return t('project_content.doc_type_report', 'Report');
        case 'security': return t('project_content.doc_type_security', 'Security document');
        default: return t('project_content.doc_type_document', 'Document');
    }
}

/** `42:07` / `1:02:03`, or '' when the length is not known yet. */
export function formatMeetingDuration(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** `850 B`, `12.4 KB`, `3.1 MB`, or '' when unknown. */
export function formatFileSize(bytes: number | null | undefined, locale?: string): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

/** A meeting still being transcribed, or one that failed, says so. */
export function meetingStatusLabel(t: TranslateFn, status: string | null | undefined): string {
    if (status === 'processing' || status === 'pending' || status === 'queued') return t('project_content.meeting_processing', 'Transcribing…');
    if (status === 'failed' || status === 'error') return t('project_content.meeting_failed', 'Transcription failed');
    return '';
}
