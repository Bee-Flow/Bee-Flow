import React, { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { ArrowLeft, Mic } from 'lucide-react';
import SegmentedControl from '../../components/shared/SegmentedControl';
import StudioShell from '../../components/shared/StudioShell';
import { PRIMARY_ACTION_STYLE } from '../../components/shared/StudioSectionHeader';
import useTranslation from '../../hooks/useTranslation';
import MeetingLibrary from './library/MeetingLibrary';
import UpcomingMeetings from './library/UpcomingMeetings';
import MeetingDetail from './detail/MeetingDetail';
import DetailEmptyState from './detail/DetailEmptyState';
import { useCapture } from './capture/CaptureContext';
import useTranscriptions from './hooks/useTranscriptions';
import useMeetingTags from './hooks/useMeetingTags';
import useMediaQuery from './hooks/useMediaQuery';
import useMeetingSources from './hooks/useMeetingSources';
import { useRecorder } from './hooks/RecorderContext';

/**
 * Meeting notes — the section chrome (Bee Flow Builder redesign, Sep 2026,
 * Track M1; Meeting Notes artboard 1a/1b).
 *
 * `StudioShell` with a 300px rail whose 48px head reads
 * "Meeting notes · 13 · [Record]", then the search field, the Library |
 * Upcoming segmented control — ALWAYS visible, with the upcoming count as
 * its badge; an org with no Talk/Meet connected sees the connect banners
 * under Upcoming rather than a tab that hides (a deliberate deviation from
 * the hide-when-unsupported rule, plan M1) — then the counted tag chips and
 * the compact rows. The detail on the right opens with the shared
 * StudioSectionHeader (MeetingHeader).
 *
 * The page keeps the Upcoming panel MOUNTED (hidden) once a source is
 * connected, so its count is known before the user opens it; with nothing
 * connected it mounts only on demand — its calendar probes are not free.
 */

const LIBRARY = 'library';
const UPCOMING = 'upcoming';

/**
 * `onNavigate` is the SPA's in-app router (studioApps hands it to every
 * section). It travels down to MeetingDetail because the Used-by rows, the
 * outputs bar and the delete confirmation all render a colleague-safe link
 * to whatever depends on a meeting — and without it every one of those rows
 * is plain text with no way through. Optional on purpose: this page is also
 * mounted standalone, where there is no router to hand down.
 */
function MeetingNotesInner({ user, onBack, initialMeetingId = null, onNavigate = null }) {
    const { t } = useTranslation();
    const { items, loading, error, reload, removeLocal, patchLocal } = useTranscriptions();
    const [selectedId, setSelectedId] = useState(() => {
        // The global is the older handoff (set by a caller just before it
        // navigates); `initialMeetingId` is the route-driven one, used by
        // /app/studio/meeting-notes/<id> and the sidebar's recents panel. The
        // global wins because it is set for THIS mount and cleared on read.
        if (typeof window !== 'undefined' && window.__beeflowPendingMeetingId) {
            const id = window.__beeflowPendingMeetingId;
            window.__beeflowPendingMeetingId = null;
            return id;
        }
        return initialMeetingId || null;
    });
    const { openCapture } = useCapture();
    const { version, consumeLastResult, lastResultId } = useRecorder();
    const isMobile = useMediaQuery('(max-width: 767px)');
    const [leftView, setLeftView] = useState(LIBRARY);
    const [upcomingCount, setUpcomingCount] = useState(null);

    // Whether a live-meeting source is connected decides only whether the
    // Upcoming panel is pre-mounted for its count — the segment itself is
    // always there.
    const meetingSources = useMeetingSources();
    const upcomingAvailable = !!(meetingSources.talk || meetingSources.gmeet);
    const upcomingMounted = leftView === UPCOMING || upcomingAvailable;

    // The tag vocabulary with counts; re-asked when a tag changes on a note.
    const [tagsKey, setTagsKey] = useState(0);
    const { tags } = useMeetingTags(items, tagsKey);

    // When a capture finishes anywhere in the app, refresh the list and
    // auto-select the new transcription if one is pending. If the upload
    // was transparently re-routed to a cloud provider (e.g. because the
    // local CPU model couldn't handle the recording length), surface a
    // soft notice so the user understands why.
    const [fallbackNotice, setFallbackNotice] = useState(null);

    // Handle results that completed while the page was *not* mounted: the
    // upload finished from another route (e.g. the capture modal closed),
    // and the user lands here with a pending id we still need to claim.
    const claimResult = useEffectEvent(() => {
        reload().then(() => {
            const { id, meta } = consumeLastResult();
            if (id) setSelectedId(id);
            if (meta?.providerFallback) setFallbackNotice(meta.providerFallback);
        });
    });
    useEffect(() => {
        if (lastResultId) claimResult();
    }, [lastResultId]);

    // Bump-driven refresh: catches subsequent uploads that finish while
    // this page is open even if the consumer above already claimed an id.
    useEffect(() => {
        if (version !== 0) claimResult();
    }, [version]);

    // Auto-dismiss the soft provider-fallback notice — it's informational,
    // not actionable, so it shouldn't linger.
    useEffect(() => {
        if (!fallbackNotice) return undefined;
        const timer = setTimeout(() => setFallbackNotice(null), 10000);
        return () => clearTimeout(timer);
    }, [fallbackNotice]);

    const onDeleted = (id) => {
        removeLocal(id);
        if (selectedId === id) setSelectedId(null);
        setTagsKey((k) => k + 1);
    };

    const onChanged = (id, patch) => {
        patchLocal(id, patch);
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'tags')) setTagsKey((k) => k + 1);
    };

    const openFromUpcoming = useCallback((id) => { setLeftView(LIBRARY); setSelectedId(id); }, []);

    const viewSwitch = (
        <SegmentedControl
            size="sm"
            fullWidth
            ariaLabel={t('meetings.view_label', 'Library or upcoming')}
            value={leftView}
            onChange={setLeftView}
            options={[
                { value: LIBRARY, label: t('meetings.library', 'Library') },
                { value: UPCOMING, label: t('meetings.upcoming', 'Upcoming'), badge: { count: upcomingCount } },
            ]}
        />
    );

    const rail = (
        <div className="h-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0 flex flex-col" hidden={leftView !== LIBRARY}>
                <MeetingLibrary
                    meetings={items}
                    loading={loading}
                    error={error}
                    onRetry={reload}
                    currentUserId={user?.id}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onCapture={() => openCapture()}
                    tags={tags}
                    viewSwitch={viewSwitch}
                />
            </div>
            {upcomingMounted && (
                <div className="flex-1 min-h-0 flex flex-col" hidden={leftView !== UPCOMING} data-testid="meetings-upcoming-pane">
                    <div className="px-3 pt-2.5 pb-1">{viewSwitch}</div>
                    <UpcomingMeetings onOpenNote={openFromUpcoming} onRowsChange={setUpcomingCount} />
                </div>
            )}
        </div>
    );

    const railHead = (
        <span className="flex items-center gap-2 min-w-0">
            <span className="truncate">{t('meetings.title', 'Meeting notes')}</span>
            {!loading && (
                <span className="text-xs font-normal tabular-nums" style={{ color: 'var(--text-tertiary)' }} data-testid="meetings-count">{items.length}</span>
            )}
        </span>
    );

    const recordButton = (
        <button
            type="button"
            onClick={() => openCapture()}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
            style={PRIMARY_ACTION_STYLE}
        >
            <Mic className="w-[13px] h-[13px]" aria-hidden="true" />
            {t('meetings.record', 'Record')}
        </button>
    );

    const detail = (
        <MeetingDetail
            id={selectedId}
            currentUserId={user?.id}
            currentUserName={user?.displayName || user?.username || ''}
            onBack={isMobile ? () => setSelectedId(null) : undefined}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onOpenNote={setSelectedId}
            onNavigate={onNavigate}
        />
    );

    const notice = fallbackNotice && (
        <div
            className="flex items-center justify-between gap-3 px-4 py-2 text-xs border-b"
            style={{ background: 'color-mix(in srgb, var(--accent-primary) 8%, var(--bg-secondary))', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            role="status"
        >
            <span>
                {t('meetings.fallback_notice', 'Your recording was too long for the on-device model — transcribed via {provider} instead.', { provider: fallbackNotice.to })}
            </span>
            <button
                type="button"
                onClick={() => setFallbackNotice(null)}
                className="text-xs underline opacity-80 hover:opacity-100"
            >{t('meetings.dismiss', 'Dismiss')}</button>
        </div>
    );

    // Phones: the rail is the page; a selected note covers it and carries its
    // own way back (MeetingHeader's back arrow).
    if (isMobile) {
        return (
            <div className="h-full flex flex-col relative" style={{ background: 'var(--bg-primary)' }}>
                {notice}
                <div className="flex items-center gap-2 h-12 px-3 border-b flex-shrink-0" style={{ borderColor: 'var(--border-default)' }}>
                    {onBack && (
                        <button type="button" onClick={onBack} aria-label={t('studio.header.back', 'Back')} className="grid place-items-center w-8 h-8 rounded-lg" style={{ color: 'var(--text-secondary)' }}>
                            <ArrowLeft size={16} aria-hidden="true" />
                        </button>
                    )}
                    <span className="text-sm font-semibold flex-1 min-w-0" style={{ color: 'var(--text-primary)' }}>{railHead}</span>
                    {recordButton}
                </div>
                {!selectedId ? (
                    <div className="flex-1 min-h-0 overflow-y-auto">{rail}</div>
                ) : (
                    <div className="flex-1 min-h-0 flex flex-col">{detail}</div>
                )}
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
            {notice}
            <div className="flex-1 min-h-0">
                <StudioShell
                    sidebarTitle={railHead}
                    sidebarActions={recordButton}
                    sidebarWidthClass="w-[300px]"
                    sidebar={rail}
                >
                    {selectedId ? detail : <DetailEmptyState />}
                </StudioShell>
            </div>
        </div>
    );
}

export default function MeetingNotesPage(props) {
    return <MeetingNotesInner {...props} />;
}
