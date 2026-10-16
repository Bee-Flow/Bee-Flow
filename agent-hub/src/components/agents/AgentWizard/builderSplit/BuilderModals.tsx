import AgentConflictModal from '../AgentConflictModal';
import AdvancedDrawer from '../pickers/AdvancedDrawer';
import FilesUploadModal from '../pickers/FilesUploadModal';
import { ScheduleModal } from '../pickers/SchedulePickers';
import type { ReactNode } from 'react';
import EnableEmbedConfirmModal from './EnableEmbedConfirmModal';
import ScheduleDeleteModal from './ScheduleDeleteModal';
import type { Ref } from './agentSaveTypes';
import type useAgentSave from './useAgentSave';
import type useBuilderState from './useBuilderState';
import type useEditorActions from './useEditorActions';
import type { TranslateFn } from '../../../../hooks/useTranslation';

interface Props {
    t: TranslateFn;
    s: ReturnType<typeof useBuilderState>;
    actions: ReturnType<typeof useEditorActions>;
    save: ReturnType<typeof useAgentSave>;
    schedulesAllowed: boolean;
    refreshAgentSchedules: () => Promise<unknown> | void;
    handleVersionRestore: () => Promise<void>;
    mountedRef: Ref<boolean>;
    onDocCountChange: (kbId: string, total: number) => void;
    toolChooser: ReactNode;
}

/**
 * Every dialog and drawer of the agent editor (BuilderSplit), each rendered
 * only while its flag in the editor state is set. State stays in the parent.
 */
export default function BuilderModals({ t, s, actions, save, schedulesAllowed, refreshAgentSchedules, handleVersionRestore, mountedRef, onDocCountChange, toolChooser }: Props) {
    const { agent, name, knowledgeBaseIds } = s;
    return (
        <>
            {/* BFSF-270: no `agent?.id` gate — for unsaved drafts the pill used
                to flip knowledgeOpen and render NOTHING (a silent no-op). The
                server never required a saved agent: uploads are KB-scoped and
                the KB link is staged in stateRef.current.config, which the
                draft's first save persists. */}
            {s.knowledgeOpen && (
                <FilesUploadModal
                    t={t}
                    agent={agent}
                    agentName={name}
                    knowledgeBaseIds={knowledgeBaseIds}
                    onKnowledgeBaseIdsChange={actions.onKnowledgeBaseIdsChange}
                    allKbs={actions.allKbs}
                    onToggleKbLink={actions.toggleKbLink}
                    onCreateKb={actions.createKb}
                    onDocCountChange={onDocCountChange}
                    onKbsChange={actions.refreshKbs}
                    onClose={() => s.setKnowledgeOpen(false)}
                />
            )}
            {toolChooser}
            {s.scheduleModal && agent?.id && schedulesAllowed && (
                <ScheduleModal
                    t={t}
                    agent={agent}
                    initialSchedule={s.scheduleModal.mode === 'edit' ? s.scheduleModal.schedule : null}
                    onClose={() => s.setScheduleModal(null)}
                    onSaved={async () => {
                        s.setScheduleModal(null);
                        await refreshAgentSchedules();
                    }}
                />
            )}
            {actions.pendingEmbedEnable && (
                <EnableEmbedConfirmModal
                    t={t}
                    agent={agent}
                    onConfirm={actions.confirmEnableEmbed}
                    onCancel={actions.cancelEnableEmbed}
                />
            )}
            {save.conflict && (
                <AgentConflictModal
                    t={t}
                    busy={save.conflictBusy}
                    onLoadLatest={save.handleConflictLoadLatest}
                    onOverwrite={save.handleConflictOverwrite}
                    onDismiss={save.handleConflictDismiss}
                />
            )}
            {s.scheduleDeleteTarget && (
                <ScheduleDeleteModal
                    t={t}
                    scheduleDeleteTarget={s.scheduleDeleteTarget}
                    scheduleDeleting={s.scheduleDeleting}
                    setScheduleDeleteTarget={s.setScheduleDeleteTarget}
                    setScheduleDeleting={s.setScheduleDeleting}
                    refreshAgentSchedules={refreshAgentSchedules}
                    mountedRef={mountedRef}
                />
            )}
            <AdvancedDrawer
                open={s.advancedOpen}
                onClose={() => s.setAdvancedOpen(false)}
                t={t}
                agent={agent}
                onVersionRestore={handleVersionRestore}
                allowCopy={s.allowCopy}
                onToggleAllowCopy={actions.toggleAllowCopy}
                disableExternalTools={s.disableExternalTools}
                onToggleDisableExternalTools={actions.toggleDisableExternalTools}
                embedEnabled={s.embedEnabled}
                onToggleEmbedEnabled={actions.toggleEmbedEnabled}
                bubbleColor={s.bubbleColor}
                onBubbleColor={actions.updateBubbleColor}
                bubblePosition={s.bubblePosition}
                onBubblePosition={actions.updateBubblePosition}
                bubbleIcon={s.bubbleIcon}
                onBubbleIcon={actions.updateBubbleIcon}
                memoryEnabled={s.memoryEnabled}
                onToggleMemory={actions.toggleMemory}
                useGeneralMemory={s.useGeneralMemory}
                onToggleUseGeneralMemory={actions.toggleUseGeneralMemory}
            />
        </>
    );
}
