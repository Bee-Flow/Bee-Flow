import type { ReactNode } from 'react';
import AgentEditorHeader, { AGENT_TAB_IDS } from './AgentEditorHeader';
import BuilderChatPanel from './BuilderChatPanel';
import BuilderMain from './BuilderMain';
import BuilderModals from './BuilderModals';
import { LimitWarningBanner } from './BuilderTabPanels';
import type { Ref } from '../../../../api/agentSaveTypes';
import type { NavigateFn, HeaderExtras } from './editorTypes';
import type { RelativeTimeInput } from '../../../../hooks/useRelativeTime';
import type useAgentTests from '../tests/useAgentTests';
import type { createHandleRefine } from './refineActions';
import type { createUndoRefine } from './undoRefine';
import type useChatPanelResize from './useChatPanelResize';
import type useAgentBootstrapData from './useAgentBootstrapData';
import type useAgentSave from './useAgentSave';
import type useAgentSchedules from './useAgentSchedules';
import type useBuilderState from './useBuilderState';
import type useCanUseTab from './useCanUseTab';
import type useEditorActions from './useEditorActions';
import type useEditorDerived from './useEditorDerived';
import type { TranslateFn } from '../../../../hooks/useTranslation';

interface Props {
    t: TranslateFn;
    ro: boolean;
    headerRo: boolean;
    rel: (dateLike: RelativeTimeInput) => string;
    user: unknown;
    locale: string | undefined;
    onNavigate: NavigateFn;
    onBack: () => void;
    rightHeaderExtras: HeaderExtras;
    s: ReturnType<typeof useBuilderState>;
    actions: ReturnType<typeof useEditorActions>;
    canUse: ReturnType<typeof useCanUseTab>;
    save: ReturnType<typeof useAgentSave>;
    boot: ReturnType<typeof useAgentBootstrapData>;
    derived: ReturnType<typeof useEditorDerived>;
    schedules: ReturnType<typeof useAgentSchedules>;
    testSet: ReturnType<typeof useAgentTests>;
    uploadDocCount: number | null | undefined;
    onDocCountChange: (kbId: string, total: number) => void;
    flushNow: () => void;
    handleRefine: ReturnType<typeof createHandleRefine>;
    handleUndoRefine: ReturnType<typeof createUndoRefine>;
    handleVersionRestore: () => Promise<void>;
    mountedRef: Ref<boolean>;
    chatWidth: ReturnType<typeof useChatPanelResize>['chatWidth'];
    onDragStart: ReturnType<typeof useChatPanelResize>['onDragStart'];
    /** The tool chooser dialog (a JS component whose props cannot be typed here), or false. */
    toolChooser: ReactNode;
}

/**
 * The view of the agent editor: header on top, below it the main column with
 * the refine rail on the RIGHT (A2 step 1), and the dialogs. The header is
 * NOT part of the scrolling column: the tabs, the capsule and the publish
 * button must stay in view. Everything comes in as props; no state here.
 */
export default function BuilderView(p: Props) {
    const { t, ro, s, actions, save, boot, derived } = p;
    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Plan-limit warning — a prominent, dismissible banner shown when a
                save is blocked by the org's subscription limits (e.g. max agents).
                Replaces the silent console error so the user can act on it. */}
            {s.limitWarning && <LimitWarningBanner t={t} limitWarning={s.limitWarning} setLimitWarning={s.setLimitWarning} />}

            {/* The shared Studio header. Deliberately NOT inert when read-only:
                the back arrow and the tabs must keep working for someone who may
                only view the agent (BFSF-271). */}
            <AgentEditorHeader
                t={t}
                ro={p.headerRo}
                agent={s.agent}
                name={s.name}
                avatar={s.avatar}
                onBack={p.onBack}
                onRename={(next: string) => { actions.updateName(next); save.flush(); }}
                tabs={derived.tabs}
                activeTab={s.activeTab}
                onTab={s.setActiveTab}
                savingState={s.savingState}
                savedAt={s.savedAt}
                saveErrorMsg={s.saveErrorMsg}
                onRetrySave={save.flush}
                saveDraft={save.saveDraft}
                publishedVersion={derived.publishedVersion}
                onPublishVersion={save.publishVersion}
                publishing={save.publishing}
                capsuleOpen={s.publishPickerOpen}
                onCapsuleToggle={() => s.setPublishPickerOpen(v => !v)}
                onCapsuleClose={() => s.setPublishPickerOpen(false)}
                isPublished={s.isPublished}
                sharedGroups={s.sharedGroups}
                orgGroups={boot.orgGroups}
                embedEnabled={s.embedEnabled}
                onSetPersonal={actions.setPublishPersonal}
                onSetEntireOrg={actions.setPublishEntireOrg}
                onToggleGroup={actions.togglePublishGroup}
                extras={p.rightHeaderExtras}
            />

            <div className="flex flex-1 min-h-0">
                <BuilderMain
                    t={t} ro={ro} rel={p.rel} user={p.user} locale={p.locale} onNavigate={p.onNavigate} s={s} actions={actions}
                    canUse={p.canUse} boot={boot} derived={derived} schedules={p.schedules} testSet={p.testSet}
                    uploadDocCount={p.uploadDocCount} flushNow={p.flushNow}
                />

                {/* Drag handle — left OF the rail, so dragging left makes the
                    rail wider (useChatPanelResize side='right'). */}
                {!ro && (
                <div
                    onMouseDown={p.onDragStart}
                    data-testid="refine-rail-handle"
                    className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors z-10"
                />
                )}

                {/* The refine rail. Hidden when read-only: refining
                    mutates the agent (BFSF-271). */}
                {!ro && (
                    <BuilderChatPanel
                        chatWidth={p.chatWidth}
                        t={t}
                        chatScrollRef={s.chatScrollRef}
                        chat={s.chat}
                        chatInput={s.chatInput}
                        setChatInput={s.setChatInput}
                        handleRefine={p.handleRefine}
                        chatBusy={s.chatBusy}
                        tiers={boot.tiers}
                        chatTier={s.chatTier}
                        setChatTier={s.setChatTier}
                        onTestAgent={() => s.setActiveTab(AGENT_TAB_IDS.TEST)}
                        onUndoRefine={p.handleUndoRefine}
                    />
                )}
            </div>

            <BuilderModals
                t={t} s={s} actions={actions} save={save} schedulesAllowed={p.schedules.schedulesAllowed}
                refreshAgentSchedules={p.schedules.refreshAgentSchedules} handleVersionRestore={p.handleVersionRestore}
                mountedRef={p.mountedRef} onDocCountChange={p.onDocCountChange} toolChooser={p.toolChooser}
            />
        </div>
    );
}
