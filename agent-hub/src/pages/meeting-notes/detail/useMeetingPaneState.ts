import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { findNameMentions } from '../lib/insightsData';
import { parseTimestampToSeconds } from '../lib/format';
import { buildMentionMarkers, buildTimelineMarkers } from '../lib/timelineMarkers';
import * as api from '@/api/transcriptionsApi';
import { TABS } from './MeetingHeader';
import type { MeetingNote, SeriesPrevious } from './meetingDetailTypes';
import type { CustomTemplate, SummaryTemplates } from './summaryTemplates.types';


/**
 * Custom summary templates (built-ins + the caller's user/org/group ones) are
 * user-scoped, not per-meeting — load once and refresh after edits. Also the
 * template editor's open state.
 */
function useSummaryTemplates() {
    const [templates, setTemplates] = useState<SummaryTemplates | null>(null);
    const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<CustomTemplate | null>(null);
    const reloadTemplates = useCallback(() => {
        api.listSummaryTemplates().then(setTemplates).catch(() => {});
    }, []);
    useEffect(() => { reloadTemplates(); }, [reloadTemplates]);
    const openNewTemplate = useCallback(() => { setEditingTemplate(null); setTemplateEditorOpen(true); }, []);
    const openEditTemplate = useCallback((tpl: CustomTemplate) => { setEditingTemplate(tpl); setTemplateEditorOpen(true); }, []);
    return { templates, reloadTemplates, templateEditorOpen, setTemplateEditorOpen, editingTemplate, openNewTemplate, openEditTemplate };
}

/**
 * Recurring-series context: the previous note from the same Meet code / Talk
 * room. Only fetched for completed notes that carry a series link.
 */
function useSeriesPrevious(data: MeetingNote | null) {
    const [seriesPrevious, setSeriesPrevious] = useState<SeriesPrevious | null>(null);
    useEffect(() => {
        if (!data?.id || data.status === 'processing' || data.status === 'failed') return undefined;
        if (!data.meetMeetingCode && !data.talkRoomToken) return undefined;
        let cancelled = false;
        api.getSeriesPrevious(data.id)
            .then((prev: SeriesPrevious | null) => { if (!cancelled) setSeriesPrevious(prev); })
            .catch(() => { /* context card is best-effort */ });
        return () => { cancelled = true; };
    }, [data?.id, data?.status, data?.meetMeetingCode, data?.talkRoomToken]);
    return { seriesPrevious, setSeriesPrevious };
}

/** The player handle, seeking, and the markers pinned onto its scrubber. */
function usePlayer(data: MeetingNote | null, currentUserName: string | undefined) {
    const playerApi = useRef<{ seek: (sec: number) => void } | null>(null);
    const onPlayerReady = useCallback((apiRef: { seek: (sec: number) => void }) => { playerApi.current = apiRef; }, []);
    const seek = useCallback((tsOrSec: number | string) => {
        const sec = typeof tsOrSec === 'number' ? tsOrSec : parseTimestampToSeconds(tsOrSec);
        playerApi.current?.seek(sec);
    }, []);
    // Pin every extracted "moment" — action items, decisions, raised questions —
    // onto the scrubber so the recording becomes navigable by what happened,
    // rather than by dragging through 100 minutes of audio.
    const timelineMarkers = useMemo(
        () => buildTimelineMarkers(
            [...(data?.actionItems || []), ...(data?.decisions || []), ...(data?.questions || [])],
            data?.durationSeconds,
        ),
        [data?.actionItems, data?.decisions, data?.questions, data?.durationSeconds],
    );
    // Private "my mentions": where someone else spoke the viewer's name.
    // Derived per viewer at render time — never persisted, never shared.
    const mentionMarkers = useMemo(
        () => buildMentionMarkers(findNameMentions(data?.segments, currentUserName), data?.durationSeconds),
        [data?.segments, currentUserName, data?.durationSeconds],
    );
    return { onPlayerReady, seek, timelineMarkers, mentionMarkers };
}

/**
 * The detail view's pane state: chat, tab, speaker editor, the "regenerate?"
 * offer, the summary templates, the series card and the player.
 *
 * Transient pane state is reset whenever the user navigates to a different
 * meeting — otherwise a leftover "regenerate?" banner or open speaker editor
 * would apply to the wrong meeting. `onReset` clears the caller's own
 * per-meeting flags (busy, regenerating) in the same pass.
 */
export default function useMeetingPaneState(id: string | null, data: MeetingNote | null, currentUserName: string | undefined, onReset: () => void) {
    const [chatOpen, setChatOpen] = useState(false);
    const [tab, setTab] = useState<string>(TABS.SUMMARY);
    const [speakerEditorOpen, setSpeakerEditorOpen] = useState(false);
    const [regenerateOffer, setRegenerateOffer] = useState(false);
    const templates = useSummaryTemplates();
    const { setTemplateEditorOpen } = templates;
    const series = useSeriesPrevious(data);
    const { setSeriesPrevious } = series;

    const resetPanes = useEffectEvent(() => {
        setChatOpen(false);
        setTab(TABS.SUMMARY);
        setSpeakerEditorOpen(false);
        setRegenerateOffer(false);
        setTemplateEditorOpen(false);
        onReset();
        setSeriesPrevious(null);
    });
    useEffect(() => { resetPanes(); }, [id]);

    return {
        chatOpen, setChatOpen, tab, setTab, speakerEditorOpen, setSpeakerEditorOpen,
        regenerateOffer, setRegenerateOffer, templates, seriesPrevious: series.seriesPrevious,
        player: usePlayer(data, currentUserName),
    };
}
