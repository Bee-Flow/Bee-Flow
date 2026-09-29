import React from 'react';
import { AudioLines, Loader2, Share2, TriangleAlert } from 'lucide-react';
import { kindColorVar, kindTint } from '../../../components/shared/kindColors';
import useTranslation from '../../../hooks/useTranslation';
import { formatDuration, formatRelativeDate } from '../lib/format';
import { getSourceMeta } from '../lib/sourceMeta';

/**
 * One row of the library rail (Meeting Notes artboard 1a, lines 33-37):
 *
 *   [32px tile]  Update Bee Flow KNLTB
 *                27 jul · 1:01 · 14 acties open
 *
 * The tile is `audio-lines` on `kindTint('meeting', 16)` in `--kind-meet`
 * for the SELECTED row and a neutral `--bg-tertiary` tile otherwise; a failed
 * note swaps the glyph for `triangle-alert` in `--error`, a note still
 * transcribing shows a spinner. The meta line is date · duration · one
 * status phrase, read from the list aggregates the server computes
 * (`actionsOpen` / `actionsTotal` / `failureReason` — transcriptionStore
 * LIST_AGGREGATES), never from an action_items array a list row does not
 * carry.
 */

export function actionsPhrase(meeting, t) {
    const status = meeting.status || 'completed';
    if (status === 'processing') return t('meetings.row_transcribing', 'transcribing…');
    if (status === 'failed') {
        const reason = String(meeting.failureReason || '').replace(/^Transcription failed:\s*/i, '').trim();
        return reason || t('meetings.row_failed', 'transcription failed');
    }
    const total = Number(meeting.actionsTotal) || 0;
    const open = Number(meeting.actionsOpen) || 0;
    if (open > 0) return t('meetings.row_actions_open', '{count} actions open', { count: open });
    if (total > 0) return t('meetings.row_actions_done', 'all done');
    return '';
}

export default function MeetingRow({ meeting, active, onClick }) {
    const { t } = useTranslation();
    const status = meeting.status || 'completed';
    const sourceMeta = getSourceMeta(meeting.source);
    const failed = status === 'failed';
    const processing = status === 'processing';
    const groupCount = Array.isArray(meeting.sharedGroups) ? meeting.sharedGroups.length : 0;
    const publishTitle = meeting.isPublished
        ? (groupCount > 0
            ? t('meetings.row_shared_groups', 'Shared with {count} groups', { count: groupCount })
            : t('meetings.row_shared_org', 'Shared with your organisation'))
        : '';

    const phrase = actionsPhrase(meeting, t);
    const meta = [formatRelativeDate(meeting.createdAt), formatDuration(meeting.durationSeconds), phrase].filter(Boolean);

    const tile = failed
        ? { background: 'var(--bg-tertiary)', color: 'var(--error)' }
        : active
            ? { background: kindTint('meeting', 16), color: kindColorVar('meeting') }
            : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };

    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'true' : undefined}
            data-testid="meeting-row"
            className="w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] hover:bg-[var(--bg-secondary)]"
            style={{
                background: active ? 'var(--bg-card)' : 'transparent',
                boxShadow: active ? 'var(--shadow-sm)' : 'none',
                color: 'var(--text-primary)',
            }}
        >
            <div className="w-8 h-8 rounded-lg grid place-items-center flex-shrink-0" style={tile} aria-hidden="true">
                {failed
                    ? <TriangleAlert className="w-[15px] h-[15px]" />
                    : processing
                        ? <Loader2 className="w-[15px] h-[15px] animate-spin" />
                        : <AudioLines className="w-[15px] h-[15px]" />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[13px] font-medium truncate">{meeting.title || t('meetings.untitled', 'Untitled meeting')}</span>
                    {sourceMeta && (
                        <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-px rounded-full flex-shrink-0"
                            title={sourceMeta.title}
                            style={{ color: sourceMeta.color, background: `color-mix(in srgb, ${sourceMeta.color} 12%, transparent)` }}
                        >
                            <sourceMeta.Icon className="w-2.5 h-2.5" aria-hidden="true" />
                            {sourceMeta.label}
                        </span>
                    )}
                    {meeting.isPublished && (
                        <span className="inline-flex flex-shrink-0" title={publishTitle} aria-label={publishTitle} role="img" style={{ color: 'var(--text-tertiary)' }}>
                            <Share2 className="w-3 h-3" aria-hidden="true" />
                        </span>
                    )}
                </div>
                <div className="text-[11px] truncate" style={{ color: failed ? 'var(--error)' : 'var(--text-tertiary)' }} data-testid="meeting-row-meta">
                    {meta.join(' · ')}
                </div>
            </div>
        </button>
    );
}
