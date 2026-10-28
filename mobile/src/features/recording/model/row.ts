/**
 * What one meeting row in the library says. The status is carried by an icon
 * AND a word, never by colour alone, and 'processing' reads as "working on
 * it" rather than as an error: it is a normal state that lasts minutes.
 */

import { translate } from '@/core/i18n';

import { formatDuration } from './format';
import type { TranscriptionStatus, TranscriptionSummary } from './types';

export function statusLabel(status: TranscriptionStatus): string {
    switch (status) {
        case 'processing':
            return translate('mobile.recording.status_transcribing', 'Transcribing');
        case 'failed':
            return translate('automations.ndv.quick_failed', 'Failed');
        default:
            return translate('mobile.recording.status_ready', 'Ready');
    }
}

/**
 * Under the title, in priority order: a failure needs explaining, a job in
 * flight needs reassuring, and a finished note is best described by what it
 * was actually about.
 */
export function rowSubtitle(item: TranscriptionSummary): string | undefined {
    if (item.status === 'failed') return translate('mobile.recording.row_failed', 'Transcription did not finish. Open it to retry.');
    if (item.status === 'processing') return translate('mobile.recording.row_processing', 'Transcribing and summarising — this can take a few minutes.');
    return (item.summarySnippet || item.transcriptSnippet || '').replace(/\s+/g, ' ').trim() || undefined;
}

/** Length and speakers of a finished note, for the trailing text. */
export function rowFacts(item: TranscriptionSummary): string[] {
    const count = item.speakerCount;
    return [
        item.durationSeconds ? formatDuration(item.durationSeconds) : null,
        count
            ? count === 1
                ? translate('meetings.one_speaker', '1 speaker')
                : translate('meetings.n_speakers', '{count} speakers', { count })
            : null,
    ].filter((value): value is string => Boolean(value));
}
