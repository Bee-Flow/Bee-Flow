import React from 'react';
import UsedByTab from '../../../components/shared/UsedByTab';
import useTranslation from '../../../hooks/useTranslation';
import SummaryView from './SummaryView';
import ActionItemsList from './ActionItemsList';
import DecisionsQuestionsPanel from './DecisionsQuestionsPanel';
import ExtractedPanel from './ExtractedPanel';
import InsightsPanel from './InsightsPanel';
import TranscriptView from './TranscriptView';
import { TABS } from './MeetingHeader';
import useMediaQuery from '../hooks/useMediaQuery';

/**
 * The body under the meeting head, driven by the head's tab strip (Meeting
 * Notes artboard 1a/1b; Track M1). One model on every width — the phone
 * strip that used to live here folded into the head's own narrow-width menu:
 *
 *   summary     the three Insights StatChips (headline mode — kept visible
 *               above the summary on purpose; the artboard hides them
 *               behind the Insights tab) · Summary · Actions + Decisions
 *   transcript  the transcript — a tab on desktop too, not a section below;
 *               from M4 every line has a popover and a classification column,
 *               with the "Pulled from this transcript" panel beside it (M4
 *               step 2): what those popovers have produced so far
 *   insights    the full InsightsPanel, unfolded
 *   usedby      the shared UsedByTab over `usage` (M2 lands the endpoint;
 *               until then the tab says it could not load who uses this)
 */
export default function SummaryActionsLayout({
    meeting,
    tab = TABS.SUMMARY,
    onShowInsights,
    onSeek,
    onEditSpeakers,
    onToggleActionItem,
    onEditActionItem,
    onSetActionDestination,
    onAddLineAction,
    onAddLineDecision,
    onRegenerateSummary,
    regenerating,
    templates,
    onNewTemplate,
    onEditTemplate,
    viewerName,
    perPersonInsights = true,
    usage = null,
    usageLoading = false,
    usageError = null,
    // The kinds the server could NOT answer for. Threaded through rather than
    // re-derived: "I could not check knowledge bases" and "no knowledge base
    // holds a line from this" are different sentences, and the panel beside
    // the transcript has to be able to say the first one.
    usageUnchecked = [],
    currentUserId = null,
    onNavigate = null,
}) {
    const { t } = useTranslation();
    const isMobile = useMediaQuery('(max-width: 767px)');

    if (tab === TABS.TRANSCRIPT) {
        const transcript = (
            <TranscriptView
                segments={meeting.segments || []}
                speakers={meeting.speakers || []}
                fullText={meeting.fullText || meeting.transcript}
                meeting={meeting}
                onSeek={onSeek}
                onEditSpeakers={onEditSpeakers}
                // Owner-only, and the two rows are not drawn at all without
                // them: "Actie" and "Besluit" write on the NOTE, which a
                // colleague reading a shared meeting may not do. The other
                // three entries write into the viewer's own workspace and stay.
                onAddLineAction={onAddLineAction}
                onAddLineDecision={onAddLineDecision}
            />
        );
        const extracted = (
            <ExtractedPanel
                meeting={meeting}
                usage={usage}
                usageUnchecked={usageUnchecked}
                usageError={usageError}
                perPersonEnabled={perPersonInsights}
                currentUserId={currentUserId}
                onNavigate={onNavigate}
                // Owner-only, exactly like the popover rows: only somebody who
                // may edit the speakers gets asked about a missing one.
                onEditSpeakers={onEditSpeakers}
            />
        );
        // The panel is a RAIL beside the transcript, and under it on a phone —
        // the transcript is what the tab is for, so it keeps the width.
        return isMobile ? (
            <div className="flex flex-col gap-4">{transcript}{extracted}</div>
        ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,300px)] gap-4 items-start">
                {transcript}
                {extracted}
            </div>
        );
    }

    if (tab === TABS.INSIGHTS) {
        return (
            <InsightsPanel
                meeting={meeting}
                onSeek={onSeek}
                viewerName={viewerName}
                perPersonEnabled={perPersonInsights}
                mode="full"
            />
        );
    }

    if (tab === TABS.USED_BY) {
        return (
            <UsedByTab
                rows={usage}
                loading={usageLoading}
                error={usageError}
                currentUserId={currentUserId}
                onNavigate={onNavigate}
                emptyText={t('meetings.used_by_empty', 'Nothing uses this meeting yet.')}
            />
        );
    }

    const summary = (
        <SummaryView
            summary={meeting.summary}
            onRegenerate={onRegenerateSummary}
            regenerating={regenerating}
            templates={templates}
            onNewTemplate={onNewTemplate}
            onEditTemplate={onEditTemplate}
            // Voor de regel "met welk sjabloon is dit geschreven" (M4 stap 3).
            // De notitie draagt het id én de versie van het moment van
            // schrijven; het sjabloon zelf levert alleen de naam.
            meeting={meeting}
        />
    );
    const actions = (
        <div className="flex flex-col gap-4 min-w-0">
            <ActionItemsList
                items={meeting.actionItems || []}
                meeting={meeting}
                onToggle={onToggleActionItem}
                onEdit={onEditActionItem}
                onSeek={onSeek}
                onSetDestination={onSetActionDestination}
            />
            <DecisionsQuestionsPanel decisions={meeting.decisions || []} questions={meeting.questions || []} onSeek={onSeek} />
        </div>
    );

    return (
        <div className="flex flex-col gap-4">
            {/* The three headline numbers stay above the summary; "Show
                details" opens the Insights tab in the head. */}
            <InsightsPanel
                meeting={meeting}
                onSeek={onSeek}
                viewerName={viewerName}
                perPersonEnabled={perPersonInsights}
                mode="headline"
                onShowDetails={onShowInsights}
            />
            {isMobile ? (
                <>
                    {summary}
                    {actions}
                </>
            ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,380px)] gap-4" style={{ minHeight: 320 }}>
                    {summary}
                    {actions}
                </div>
            )}
        </div>
    );
}
