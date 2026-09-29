import React, { useRef, useState } from 'react';
import {
    BarChart3, Copy, Download, FileText, Link2, MoreHorizontal, RefreshCw, ScrollText, Sparkles, Trash2, UsersRound,
} from 'lucide-react';
import AnchoredMenu from '../../../components/shared/AnchoredMenu';
import StudioSectionHeader, { OBJHEAD_FOLD } from '../../../components/shared/StudioSectionHeader';
import useTranslation from '../../../hooks/useTranslation';
import { formatDuration, formatRelativeDate } from '../lib/format';
import { getSourceMeta } from '../lib/sourceMeta';

/**
 * The meeting's 48px head — the shared StudioSectionHeader (Track 0.2) with
 * the meeting kind's tile, the title (rename inline, owner only), a plain
 * meta line "27 jul · 1:01:33 · 1 speaker · NL · Meet", the tab strip
 * Summary · Transcript · Insights · Used by n, the visibility capsule the
 * caller hands in, "Ask AI" with sparkles in `--type-ai`, and the ⋯ menu
 * (copy transcript · edit speakers · export · re-transcribe · delete) as a
 * portalled AnchoredMenu (Meeting Notes artboard 1a, lines 42-50).
 *
 * `tabs` is optional: a note that is still transcribing, or failed, has no
 * tabs to offer and renders the head without the strip.
 *
 * Props
 *   meeting            the note
 *   onBack             phones: back to the rail
 *   onRename(title)    inline rename; omitted (non-owner) → plain title
 *   tabs / activeTab / onTab   see TABS; `usedByCount` feeds the last badge
 *   capsule            node — the MeetingVisibility capsule
 *   onToggleChat / chatVisible   the Ask-AI toggle
 *   onDelete / onReprocess / onExport(fmt) / onCopyTranscript / onEditSpeakers
 *   busy / audioGone   gate Re-transcribe
 */

export const TABS = Object.freeze({
    SUMMARY: 'summary',
    TRANSCRIPT: 'transcript',
    INSIGHTS: 'insights',
    USED_BY: 'usedby',
});

export default function MeetingHeader({
    meeting,
    onBack,
    onRename,
    onDelete,
    onReprocess,
    onExport,
    onCopyTranscript,
    onEditSpeakers,
    onToggleChat,
    chatVisible = false,
    busy = false,
    // Derived server-side: no audio and nothing to recover it from.
    audioGone = false,
    tabs = false,
    activeTab = TABS.SUMMARY,
    onTab,
    usedByCount,
    capsule = null,
}) {
    const { t } = useTranslation();
    const sourceMeta = getSourceMeta(meeting.source);
    const canEdit = meeting.isOwner !== false;

    const metaParts = [
        formatRelativeDate(meeting.createdAt),
        formatDuration(meeting.durationSeconds),
        meeting.speakerCount > 0
            ? (meeting.speakerCount === 1
                ? t('meetings.one_speaker', '1 speaker')
                : t('meetings.n_speakers', '{count} speakers', { count: meeting.speakerCount }))
            : null,
        meeting.language ? String(meeting.language).toUpperCase() : null,
    ].filter(Boolean);

    const meta = (
        <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap min-w-0" style={{ color: 'var(--text-tertiary)' }} data-testid="meeting-meta">
            <span className="truncate">{metaParts.join(' · ')}</span>
            {sourceMeta && (
                <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-px rounded-full"
                    title={sourceMeta.title}
                    style={{ color: sourceMeta.color, background: `color-mix(in srgb, ${sourceMeta.color} 12%, transparent)` }}
                >
                    <sourceMeta.Icon className="w-2.5 h-2.5" aria-hidden="true" />
                    {sourceMeta.label}
                </span>
            )}
        </span>
    );

    const tabList = tabs ? [
        { id: TABS.SUMMARY, label: t('meetings.tab_summary', 'Summary'), icon: FileText },
        { id: TABS.TRANSCRIPT, label: t('meetings.tab_transcript', 'Transcript'), icon: ScrollText },
        { id: TABS.INSIGHTS, label: t('meetings.tab_insights', 'Insights'), icon: BarChart3 },
        { id: TABS.USED_BY, label: t('meetings.tab_used_by', 'Used by'), icon: Link2, count: usedByCount },
    ] : null;

    const askAi = onToggleChat ? (
        <button
            type="button"
            onClick={onToggleChat}
            aria-pressed={chatVisible}
            data-testid="meeting-ask-ai"
            className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap transition-colors hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            style={{
                height: 32,
                padding: '0 12px',
                borderRadius: 10,
                border: `1px solid ${chatVisible ? 'var(--type-ai)' : 'var(--border-default)'}`,
                background: chatVisible ? 'color-mix(in srgb, var(--type-ai) 12%, transparent)' : 'var(--bg-card)',
                color: 'var(--text-primary)',
            }}
        >
            <Sparkles size={13} aria-hidden="true" style={{ color: 'var(--type-ai)' }} />
            <span className={OBJHEAD_FOLD.label}>{t('meetings.ask_ai', 'Ask AI')}</span>
        </button>
    ) : null;

    return (
        <StudioSectionHeader
            kind="meeting"
            title={meeting.title || ''}
            onRename={canEdit && onRename ? onRename : undefined}
            statusChip={meta}
            tabs={tabList}
            activeTab={activeTab}
            onTab={onTab}
            capsule={capsule}
            primary={askAi}
            extras={(
                <OverflowMenu
                    t={t}
                    canEdit={canEdit}
                    busy={busy}
                    audioGone={audioGone}
                    onCopyTranscript={onCopyTranscript}
                    onEditSpeakers={onEditSpeakers}
                    onExport={onExport}
                    onReprocess={onReprocess}
                    onDelete={onDelete}
                />
            )}
            onBack={onBack}
            backLabel={t('meetings.back_to_library', 'Back to library')}
            testId="meeting-header"
        />
    );
}

function OverflowMenu({ t, canEdit, busy, audioGone, onCopyTranscript, onEditSpeakers, onExport, onReprocess, onDelete }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);
    const close = () => setOpen(false);

    const items = [
        onCopyTranscript && { id: 'copy', icon: Copy, label: t('meetings.copy_transcript', 'Copy transcript'), onClick: onCopyTranscript },
        onEditSpeakers && { id: 'speakers', icon: UsersRound, label: t('meeting_notes.edit_speakers', 'Edit speakers'), onClick: onEditSpeakers },
        onExport && { id: 'md', icon: Download, label: t('meetings.export_md', 'Export as Markdown'), onClick: () => onExport('md') },
        onExport && { id: 'txt', icon: Download, label: t('meetings.export_txt', 'Export as Text'), onClick: () => onExport('txt') },
        // Disabled when the audio is gone for good. Leaving it enabled is what
        // produced the original complaint: a click, a spinner, then a message
        // telling the user to upload a file that never existed.
        onReprocess && {
            id: 'reprocess', icon: RefreshCw, label: t('meetings.retranscribe', 'Re-transcribe'), onClick: onReprocess,
            disabled: busy || audioGone,
            title: audioGone ? t('meetings.audio_gone', 'The audio for this meeting is no longer available') : undefined,
        },
        canEdit && onDelete && { id: 'delete', icon: Trash2, label: t('meetings.delete', 'Delete'), onClick: onDelete, danger: true },
    ].filter(Boolean);

    if (items.length === 0) return null;

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('meetings.more_actions', 'More actions')}
                data-testid="meeting-more"
                className="grid place-items-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                style={{ color: 'var(--text-secondary)' }}
            >
                <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={close}
                anchorRef={anchorRef}
                align="right"
                width={220}
                role="menu"
                aria-label={t('meetings.more_actions', 'More actions')}
                className="py-1"
            >
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        disabled={!!item.disabled}
                        title={item.title}
                        onClick={() => { close(); item.onClick?.(); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--bg-secondary)] disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ color: item.danger ? 'var(--error)' : 'var(--text-primary)' }}
                    >
                        <item.icon className="w-3.5 h-3.5" aria-hidden="true" />
                        {item.label}
                    </button>
                ))}
            </AnchoredMenu>
        </>
    );
}
