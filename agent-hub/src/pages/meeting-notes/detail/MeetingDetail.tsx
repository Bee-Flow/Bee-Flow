import React from 'react';
import AssistantSidebar from './AssistantSidebar';
import AudioUnavailable, { AudioNotBackedUp } from './AudioUnavailable';
import MeetingHeader, { TABS } from './MeetingHeader';
import MeetingOutputsBar from './MeetingOutputsBar';
import { DetailSkeleton, MeetingLoadError, MeetingProcessingBody, RegenerateOfferBanner } from './MeetingStatusViews';
import MeetingVisibility from './MeetingVisibility';
import SeriesPreviousCard from './SeriesPreviousCard';
import SpeakerEditor from './SpeakerEditor';
import SummaryActionsLayout from './SummaryActionsLayout';
import TagRow from './TagRow';
import TemplateEditor from './TemplateEditor';
import useMeetingCommands from './useMeetingCommands';
import useMeetingEdits from './useMeetingEdits';
import useMeetingPaneState from './useMeetingPaneState';
import WaveformPlayer from './WaveformPlayer';
import DangerZone from '../../../components/shared/DangerZone';
import Modal from '../../../components/shared/Modal';
import { toast } from '../../../components/shared/Toast';
import useConfirm from '../../../components/shared/useConfirm';
import { kindLabelFor } from '../../../components/shared/UsedByTab';
import useTranslation from '../../../hooks/useTranslation';
import useUsage from '../../../hooks/useUsage';
import useMediaQuery from '../hooks/useMediaQuery';
import useTranscription from '../hooks/useTranscription';
import * as api from '../../../api/transcriptionsApi';
import type { TranslateParams } from '../../../hooks/useTranslation';
import type { ApiError, MeetingNote, MeetingRowPatch } from './meetingDetailTypes';
import type { UsageRow } from '../../../hooks/useUsage';

/**
 * "Used by n" — ONE fetch for the tab badge, the tab body, the outputs bar
 * under the tags and the delete confirmation (Track 0.4, endpoint M2). Four
 * consumers, one list: a bar that says a knowledge base collects this meeting
 * while the delete dialog says nothing depends on it would be worse than
 * either being absent.
 *
 * `unchecked` names the kinds the server could NOT answer for. It is not
 * decoration: an incomplete list must never be presented as a complete one,
 * and the count in the tab badge stays blank rather than under-reporting.
 */
function useMeetingUsage(meetingId: string | undefined) {
    const { usage, unchecked, error: usageError, loading: usageLoading } = useUsage('meeting', meetingId || null);
    const uncheckedKinds = usageError ? [] : (unchecked || []);
    const usedByCount = (usageError || uncheckedKinds.length > 0) ? undefined : (usage === null ? undefined : usage.length);
    return { usage, uncheckedKinds, usageError, usageLoading, usedByCount };
}

/** The shared danger zone for this note, with the "could not check" notice. */
interface MeetingDangerZoneProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    data: MeetingNote;
    usage: UsageRow[] | null;
    uncheckedKinds: string[];
    onDelete: (confirmedBreaking: boolean) => unknown;
    currentUserId?: string | null;
    onNavigate: ((href: string) => void) | null;
}

function MeetingDangerZone({ t, data, usage, uncheckedKinds, onDelete, currentUserId, onNavigate }: MeetingDangerZoneProps) {
    return (
        <DangerZone
            entityName={data?.title || ''}
            usage={usage}
            onDelete={onDelete}
            kindLabel={t('usage.kind_meeting', 'meeting note')}
            currentUserId={currentUserId}
            onNavigate={onNavigate}
            requireName={uncheckedKinds.length > 0}
            openLabel={t('meetings.delete_open', 'Delete this meeting')}
            notice={uncheckedKinds.length > 0 ? (
                <p className="text-xs [color:var(--warning)]!" data-testid="meeting-delete-unchecked">
                    {t('meetings.delete_unchecked', 'Some of what could use this meeting could not be checked ({kinds}), so this list may be incomplete.', {
                        kinds: uncheckedKinds.map((k) => kindLabelFor(t, k, 2)).join(', '),
                    })}
                </p>
            ) : null}
        />
    );
}

/** All state and handlers of the open meeting note. */
interface UseMeetingDetailArgs {
    id: string | null;
    currentUserName: string;
    onChanged: (id: string, patch: MeetingRowPatch) => void;
    onDeleted: (id: string) => void;
}

function useMeetingDetail({ id, currentUserName, onChanged, onDeleted }: UseMeetingDetailArgs) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { data, loading, error, refresh, setLocal } = useTranscription(id);
    const usage = useMeetingUsage(data?.id);
    const commands = useMeetingCommands({
        data, setLocal, refresh, onChanged, onDeleted, confirm, t, uncheckedKinds: usage.uncheckedKinds,
    });
    const { setBusy, setRegenerating } = commands;
    const panes = useMeetingPaneState(id, data, currentUserName, () => { setBusy(false); setRegenerating(false); });
    const edits = useMeetingEdits({
        data, setLocal, refresh, onChanged,
        offerRegenerate: () => panes.setRegenerateOffer(true),
        notifyDestinationNotSaved: () => toast.error(t('meetings.destination_not_saved', 'That worked, but the note could not be updated. Refresh and try again.')),
    });
    // No audio and nothing to recover it from. Used to gate Re-transcribe, which
    // otherwise leads straight to a dead end.
    const audioGone = !!data?.audio && data.audio.available === false && !data.audio.recoverable;
    return { t, confirmDialog, data, loading, error, refresh, setLocal, usage, commands, panes, edits, audioGone };
}

interface MeetingDetailProps {
    id: string | null;
    currentUserId?: string | null;
    currentUserName: string;
    onBack: (() => void) | undefined;
    onChanged: (id: string, patch: MeetingRowPatch) => void;
    onDeleted: (id: string) => void;
    onOpenNote: (id: string) => void;
    onNavigate?: ((href: string) => void) | null;
}

export default function MeetingDetail({ id, currentUserId, currentUserName, onBack, onChanged, onDeleted, onOpenNote, onNavigate = null }: MeetingDetailProps) {
    const m = useMeetingDetail({ id, currentUserName, onChanged, onDeleted });
    const { t, confirmDialog, data, loading, error, refresh, setLocal, usage, commands, panes, edits, audioGone } = m;
    const isMobile = useMediaQuery('(max-width: 767px)');

    if (loading && !data) return <DetailSkeleton t={t} />;
    if (error && !data) return <MeetingLoadError t={t} error={error as ApiError} onRetry={refresh} />;
    if (!data) return null;

    const isOwner = data.isOwner !== false;
    const dangerZone = (
        <MeetingDangerZone
            t={t} data={data} usage={usage.usage} uncheckedKinds={usage.uncheckedKinds}
            onDelete={commands.handleDelete} currentUserId={currentUserId} onNavigate={onNavigate}
        />
    );

    if (data.status === 'processing' || data.status === 'failed') {
        return (
            <MeetingProcessingView
                m={m as MeetingDetailState & { data: MeetingNote }} isOwner={isOwner} onBack={isMobile ? onBack : undefined} dangerZone={dangerZone}
            />
        );
    }

    const capsule = (
        <MeetingVisibility
            meeting={data}
            canManage={isOwner}
            onChange={({ isPublished, sharedGroups }) => {
                setLocal((p) => ({ ...p, isPublished, sharedGroups }));
                onChanged?.(data.id, { isPublished, sharedGroups });
            }}
        />
    );

    return (
        <div className="h-full flex">
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                <MeetingHeader
                    meeting={data}
                    onBack={isMobile ? onBack : undefined}
                    onRename={edits.handleRename}
                    onReprocess={commands.handleReprocess}
                    onExport={commands.handleExport}
                    onCopyTranscript={commands.handleCopyTranscript}
                    onEditSpeakers={isOwner ? () => panes.setSpeakerEditorOpen(true) : undefined}
                    onToggleChat={() => panes.setChatOpen((o) => !o)}
                    chatVisible={panes.chatOpen}
                    busy={commands.busy}
                    audioGone={audioGone}
                    tabs
                    activeTab={panes.tab}
                    onTab={panes.setTab}
                    usedByCount={usage.usedByCount}
                    capsule={capsule}
                />
                {panes.regenerateOffer && (
                    <RegenerateOfferBanner
                        t={t}
                        regenerating={commands.regenerating}
                        onRegenerate={async () => { panes.setRegenerateOffer(false); await commands.handleRegenerateSummary('general'); }}
                        onDismiss={() => panes.setRegenerateOffer(false)}
                    />
                )}
                <MeetingMediaStrip
                    data={data} isOwner={isOwner} usage={usage} edits={edits} panes={panes} busy={commands.busy}
                    refresh={refresh} currentUserId={currentUserId} onNavigate={onNavigate}
                />
                <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
                    {panes.seriesPrevious && panes.tab === TABS.SUMMARY && (
                        <div className="mb-4">
                            <SeriesPreviousCard previous={panes.seriesPrevious} onOpenNote={onOpenNote} />
                        </div>
                    )}
                    <SummaryActionsLayout
                        meeting={data}
                        tab={panes.tab}
                        onShowInsights={() => panes.setTab(TABS.INSIGHTS)}
                        onSeek={panes.player.seek}
                        onEditSpeakers={isOwner ? () => panes.setSpeakerEditorOpen(true) : undefined}
                        onToggleActionItem={edits.handleToggleActionItem}
                        onEditActionItem={isOwner ? edits.handleEditActionItem : undefined}
                        // Owner-only, and the chip is not drawn at all without
                        // it: a destination names an automation, a table or a
                        // knowledge base in the owner's own workspace, which a
                        // colleague reading a published note has no business
                        // reading the name of.
                        onSetActionDestination={isOwner ? edits.handleSetActionDestination : undefined}
                        // The transcript's per-line "Actie" / "Besluit". Both
                        // write on the note, so both are the owner's alone —
                        // the popover simply does not draw the rows without
                        // them, and keeps the three that write elsewhere.
                        onAddLineAction={isOwner ? edits.handleAddLineAction : undefined}
                        onAddLineDecision={isOwner ? edits.handleAddLineDecision : undefined}
                        onRegenerateSummary={isOwner ? commands.handleRegenerateSummary : undefined}
                        regenerating={commands.regenerating}
                        templates={panes.templates.templates}
                        onNewTemplate={isOwner ? panes.templates.openNewTemplate : undefined}
                        onEditTemplate={isOwner ? panes.templates.openEditTemplate : undefined}
                        viewerName={currentUserName}
                        perPersonInsights={data.perPersonInsights !== false}
                        usage={usage.usage}
                        usageLoading={usage.usageLoading}
                        usageError={usage.usageError}
                        // Same list the outputs bar warns with: the transcript
                        // panel must be able to say "I could not check", not
                        // print a zero it did not verify.
                        usageUnchecked={usage.uncheckedKinds}
                        currentUserId={currentUserId}
                        onNavigate={onNavigate}
                    />
                    {isOwner && dangerZone}
                </div>
            </div>
            <MeetingSidePanels t={t} data={data} isMobile={isMobile} panes={panes} edits={edits} />
            {confirmDialog}
        </div>
    );
}


/** The assistant (side panel or bottom sheet), the speaker editor and the template editor. */
interface MeetingSidePanelsProps {
    panes: ReturnType<typeof useMeetingPaneState>;
    edits: ReturnType<typeof useMeetingEdits>;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    data: MeetingNote;
    isMobile: boolean;
}

function MeetingSidePanels({ t, data, isMobile, panes, edits }: MeetingSidePanelsProps) {
    const { chatOpen, setChatOpen, templates: tpl } = panes;
    const assistant = <AssistantSidebar meeting={data} open={chatOpen} onClose={() => setChatOpen(false)} />;
    return (
        <>
            {chatOpen && !isMobile && <div className="w-[380px] flex-shrink-0">{assistant}</div>}
            {chatOpen && isMobile && (
                <Modal open onClose={() => setChatOpen(false)} variant="bare" placement="bottom" size="auto" zIndex={40} label={t('meetings.ask_ai', 'Ask AI')}>
                    <div className="h-[80vh]">{assistant}</div>
                </Modal>
            )}
            <SpeakerEditor
                open={panes.speakerEditorOpen}
                onClose={() => panes.setSpeakerEditorOpen(false)}
                meeting={data}
                onSave={edits.handleSpeakerEditSave}
                onAutoDetect={edits.handleReidentifySpeakers}
            />
            <TemplateEditor
                open={tpl.templateEditorOpen}
                onClose={() => tpl.setTemplateEditorOpen(false)}
                initial={tpl.editingTemplate}
                builtins={tpl.templates?.builtins || []}
                canManageOrg={!!tpl.templates?.canManageOrg}
                onSaved={tpl.reloadTemplates}
                onDeleted={tpl.reloadTemplates}
            />
        </>
    );
}

/** Tags, the "used by" bar and the player (or why there is no audio). */
interface MeetingMediaStripProps {
    panes: ReturnType<typeof useMeetingPaneState>;
    edits: ReturnType<typeof useMeetingEdits>;
    data: MeetingNote;
    isOwner: boolean;
    usage: ReturnType<typeof useMeetingUsage>;
    busy: boolean;
    refresh: () => Promise<void>;
    currentUserId?: string | null;
    onNavigate: ((href: string) => void) | null;
}

function MeetingMediaStrip({ data, isOwner, usage, edits, panes, busy, refresh, currentUserId, onNavigate }: MeetingMediaStripProps) {
    return (
        <div className="px-4 sm:px-6 pt-3 flex flex-col gap-3">
            <TagRow
                tags={data.tags || []}
                canEdit={isOwner}
                onAddTag={edits.handleAddTag}
                onRemoveTag={edits.handleRemoveTag}
                busy={busy}
            />
            {/* Directly under the tags, because the tags are what most
                of this list is derived from: adding "sales" here is
                what puts the summary into a knowledge base, and the
                bar is where that becomes visible. Same rows as the
                Used-by tab and the delete confirmation — one fetch. */}
            <MeetingOutputsBar
                rows={usage.usage}
                unchecked={usage.uncheckedKinds}
                error={usage.usageError}
                currentUserId={currentUserId}
                onNavigate={onNavigate}
            />
            {/* `audio.available === false` is the state that used to
                render a dead player and only reveal itself when the
                user pressed Re-transcribe. Say it up front instead. */}
            {data.audio && data.audio.available === false ? (
                <AudioUnavailable audio={data.audio} onRetry={refresh} />
            ) : (
                <>
                    <WaveformPlayer
                        audioSrc={api.audioUrl(data.id)}
                        onReady={panes.player.onPlayerReady}
                        markers={panes.player.timelineMarkers}
                        mentionMarkers={panes.player.mentionMarkers}
                        segments={data.segments || []}
                        speakers={data.speakers || []}
                        chapters={data.chapters || []}
                        durationSeconds={data.durationSeconds || 0}
                    />
                    {data.audio?.localOnly && data.audio?.storageConfigured && (
                        <AudioNotBackedUp downloadUrl={api.audioDownloadUrl(data.id)} />
                    )}
                </>
            )}
        </div>
    );
}

/** A note that is still transcribing, or failed: header, status and the danger zone. */
type MeetingDetailState = ReturnType<typeof useMeetingDetail>;

interface MeetingProcessingViewProps {
    m: MeetingDetailState & { data: MeetingNote };
    isOwner: boolean;
    onBack?: (() => void) | undefined;
    dangerZone: React.JSX.Element;
}

function MeetingProcessingView({ m, isOwner, onBack, dangerZone }: MeetingProcessingViewProps) {
    const { t, data, edits, commands, audioGone, confirmDialog } = m;
    const failed = data.status === 'failed';
    return (
        <div className="h-full flex flex-col overflow-hidden">
            <MeetingHeader
                meeting={data}
                onBack={onBack}
                onRename={edits.handleRename}
                onReprocess={failed ? commands.handleReprocess : undefined}
                audioGone={audioGone}
            />
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-3">
                <MeetingProcessingBody
                    t={t} failed={failed} audioGone={audioGone} canRetry={isOwner} busy={commands.busy}
                    reason={failed ? String(data.failureReason || data.summary || '').trim() : ''}
                    onRetry={commands.handleReprocess}
                />
            </div>
            {/* A note that is still transcribing, or failed, is deletable
                too — and can already be collected by a knowledge source
                that watches its tags, so it gets the same guard rather
                than a shortcut. */}
            {isOwner && <div className="px-6 pb-6">{dangerZone}</div>}
            {confirmDialog}
        </div>
    );
}
