import React, { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles, X } from 'lucide-react';
import { PRIMARY_ACTION_STYLE } from '../../../components/shared/StudioSectionHeader';
import useTranslation from '../../../hooks/useTranslation';
import MeetingRow from './MeetingRow';
import LibraryFilters from './LibraryFilters';
import LibraryEmptyState from './LibraryEmptyState';
import ReportModal from './ReportModal';

const REPORT_MAX_NOTES = 10;

/**
 * The library half of the rail: filters on top, one compact `MeetingRow` per
 * note below (Meeting Notes artboard 1a). The grid of waveform cards went
 * with the 300px rail — a rail is a list. Multi-note "AI report" selection
 * stays: select mode turns row clicks into selection.
 *
 * `tags` is the counted vocabulary (useMeetingTags); `viewSwitch` is the
 * Library | Upcoming control the page owns, rendered between the search
 * field and the chips where the artboard puts it.
 */
export default function MeetingLibrary({
    meetings, loading, error, onRetry, currentUserId, selectedId, onSelect, onCapture,
    tags = [], viewSwitch = null,
}) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('recent');
    const [owner, setOwner] = useState('all');
    const [tag, setTag] = useState(null);
    // Multi-meeting AI report: select mode turns row clicks into selection.
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [reportOpen, setReportOpen] = useState(false);

    const toggleSelected = (m) => {
        if (m.status === 'processing' || m.status === 'failed') return;
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(m.id)) next.delete(m.id);
            else if (next.size < REPORT_MAX_NOTES) next.add(m.id);
            return next;
        });
    };
    const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); };
    const clickMeeting = (m) => (selectMode ? toggleSelected(m) : onSelect(m.id));
    const isActive = (m) => (selectMode ? selectedIds.has(m.id) : m.id === selectedId);
    const selectedMeetings = meetings.filter((m) => selectedIds.has(m.id));

    const filtered = useMemo(() => {
        let arr = meetings.slice();
        if (query) {
            const q = query.toLowerCase();
            arr = arr.filter((m) =>
                (m.title || '').toLowerCase().includes(q) ||
                (m.fileName || '').toLowerCase().includes(q) ||
                (m.tags || []).some((x) => String(x).toLowerCase().includes(q)) ||
                (m.transcriptSnippet || m.fullText || m.transcript || '').toLowerCase().includes(q),
            );
        }
        if (owner === 'mine') arr = arr.filter((m) => m.isOwner !== false && m.ownerId === currentUserId);
        if (owner === 'shared') arr = arr.filter((m) => m.ownerId && m.ownerId !== currentUserId);
        if (tag) arr = arr.filter((m) => (m.tags || []).includes(tag));
        switch (sort) {
            case 'oldest':
                arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                break;
            case 'longest':
                arr.sort((a, b) => (b.durationSeconds || 0) - (a.durationSeconds || 0));
                break;
            case 'title':
                arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
                break;
            case 'recent':
            default:
                arr.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        }
        return arr;
    }, [meetings, query, owner, tag, sort, currentUserId]);

    return (
        <div className="h-full flex flex-col">
            <div className="px-3 pt-2.5 pb-2 flex flex-col gap-2">
                <LibraryFilters
                    query={query} onQueryChange={setQuery}
                    sort={sort} onSortChange={setSort}
                    owner={owner} onOwnerChange={setOwner}
                    tag={tag} onTagChange={setTag}
                    tags={tags}
                    currentUserId={currentUserId}
                    viewSwitch={viewSwitch}
                />
                {/* Stay mounted while select mode is on: the Cancel control
                    lives here, and deleting notes down to one would otherwise
                    strand the user in a mode with no way out. */}
                {(meetings.length > 1 || selectMode) && (
                    <div className="flex items-center gap-2 text-[11px]">
                        {!selectMode ? (
                            <button
                                type="button"
                                onClick={() => setSelectMode(true)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                            >
                                <Sparkles className="w-3 h-3" aria-hidden="true" />
                                {t('meetings.ai_report', 'AI report')}
                            </button>
                        ) : (
                            <>
                                <span style={{ color: 'var(--text-tertiary)' }}>
                                    {t('meetings.report_selected', '{selected}/{max} selected — click meetings to select', { selected: selectedIds.size, max: REPORT_MAX_NOTES })}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setReportOpen(true)}
                                    disabled={selectedIds.size === 0}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium disabled:opacity-40"
                                    style={PRIMARY_ACTION_STYLE}
                                >
                                    <Sparkles className="w-3 h-3" aria-hidden="true" />
                                    {t('meetings.ask_ai', 'Ask AI')}
                                </button>
                                <button
                                    type="button"
                                    onClick={exitSelectMode}
                                    aria-label={t('meetings.cancel_selection', 'Cancel selection')}
                                    className="p-1 rounded-full transition-colors hover:bg-[var(--bg-tertiary)]"
                                    style={{ color: 'var(--text-tertiary)' }}
                                >
                                    <X className="w-3 h-3" aria-hidden="true" />
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>
            <div className="flex-1 overflow-auto px-3 pb-3">
                {loading && meetings.length === 0 && (
                    <div className="h-full flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    </div>
                )}
                {/* A failed list load is not an empty library. Without this the
                    only signal of a 500 was "No meetings yet — record your
                    first", which reads as "your recordings are gone". */}
                {!loading && error && meetings.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-4 py-8" role="alert">
                        <AlertTriangle className="w-7 h-7" style={{ color: 'var(--error)' }} aria-hidden="true" />
                        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {t('meetings.list_failed', 'Couldn’t load your meetings')}
                        </p>
                        <p className="text-xs max-w-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {error.message || t('meetings.something_wrong', 'Something went wrong.')}
                        </p>
                        {onRetry && (
                            <button
                                type="button"
                                onClick={onRetry}
                                className="mt-1 px-3 py-1.5 rounded-lg text-xs font-medium"
                                style={PRIMARY_ACTION_STYLE}
                            >
                                {t('meetings.try_again', 'Try again')}
                            </button>
                        )}
                    </div>
                )}
                {!loading && !error && meetings.length === 0 && (
                    <LibraryEmptyState onCapture={onCapture} />
                )}
                {!loading && meetings.length > 0 && filtered.length === 0 && (
                    <div className="text-center text-xs py-10" style={{ color: 'var(--text-tertiary)' }}>
                        {t('meetings.no_match', 'No meetings match your filters.')}
                    </div>
                )}
                {filtered.length > 0 && (
                    <div className="flex flex-col gap-1" role="list" aria-label={t('meetings.library', 'Library')}>
                        {filtered.map((m) => (
                            <Selectable key={m.id} meeting={m} selectMode={selectMode} t={t}>
                                <MeetingRow meeting={m} active={isActive(m)} onClick={() => clickMeeting(m)} />
                            </Selectable>
                        ))}
                    </div>
                )}
            </div>
            <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} meetings={selectedMeetings} />
        </div>
    );
}

/**
 * In select mode a still-transcribing or failed note has no content to report
 * on, so its click is a no-op. Say so visually rather than letting the row
 * look selectable and swallow the click.
 */
function Selectable({ meeting, selectMode, children, t }) {
    const unusable = selectMode && (meeting.status === 'processing' || meeting.status === 'failed');
    if (!unusable) return <div role="listitem">{children}</div>;
    return (
        <div role="listitem" className="opacity-40 cursor-not-allowed" title={t('meetings.not_ready', 'This meeting is not ready yet')}>
            {children}
        </div>
    );
}
