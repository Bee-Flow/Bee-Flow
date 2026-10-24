import React, { useRef, useEffect, useEffectEvent, useCallback, useState , useLayoutEffect } from 'react';
import { AGENT_TAB_IDS } from './builderSplit/AgentEditorHeader';
import BuilderView from './builderSplit/BuilderView';
import { createHandleRefine } from './builderSplit/refineActions';
import { createUndoRefine } from './builderSplit/undoRefine';
import { uploadDocCountOf, uploadKbIdOf, type ReportedDocCount } from './builderSplit/uploadKb';
import useAgentBootstrapData from './builderSplit/useAgentBootstrapData';
import useAgentSave from './builderSplit/useAgentSave';
import useAgentSchedules from './builderSplit/useAgentSchedules';
import useBuilderState from './builderSplit/useBuilderState';
import useCanUseTab from './builderSplit/useCanUseTab';
import useChatPanelResize from './builderSplit/useChatPanelResize';
import useEditorActions from './builderSplit/useEditorActions';
import useEditorDerived from './builderSplit/useEditorDerived';
import { useEditorSync, useMountedRef, useSkillPickerOutsideClose } from './builderSplit/useEditorEffects';
import { createVersionRestore } from './builderSplit/versionRestore';
import { READ } from './canUse/canUseFacts';
import ToolChooser from './canUse/ToolChooser';
import useAgentTests from './tests/useAgentTests';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import { managedOf } from '../../shared/managedPart';
import type { AppUserLike } from '../../projects/workspace/types';
import type { EditorAgent, EditorPlan, HeaderExtras, NavigateFn } from './builderSplit/editorTypes';
import type { AgentListRow } from '../AgentStudio/agentCardFacts';
import type { ChatMessage } from './agentEditor.types';

interface BuilderSplitProps {
    agent: EditorAgent;
    plan?: (EditorPlan & { capabilities?: string[] }) | null;
    onDeleted?: () => void;
    history: ChatMessage[];
    onPublished?: (agent: AgentListRow) => void | Promise<void>;
    rightHeaderExtras?: HeaderExtras;
    user?: AppUserLike | null;
    tier?: string;
    locale?: string;
    onBack: () => void;
    onDirtyChange?: React.Dispatch<React.SetStateAction<boolean>>;
    initialRefinement?: string | null;
    readOnly?: boolean;
    onNavigate?: NavigateFn;
}

export default function BuilderSplit({ agent: initialAgent, plan, history, tier, locale, onBack, onPublished, onDirtyChange, rightHeaderExtras = null, user = null, initialRefinement = null, readOnly = false, onNavigate = null }: BuilderSplitProps) {
    const { t } = useTranslation();
    // Relatieve tijd ("bijgewerkt gisteren") op de Kennis-kaart. De hook moet
    // hier staan — hij leest de vertaler — en wordt als functie doorgegeven,
    // zodat de kaart zelf puur blijft en zonder provider te testen is.
    const rel = useRelativeTime();

    // Every useState of the editor — moved to builderSplit/useBuilderState.ts.
    const s = useBuilderState(initialAgent, plan, history, t);
    const {
        agent, setAgent, forcedReadOnly, setForcedReadOnly, name, setName, avatar, setAvatar, description, setDescription,
        instructions, setInstructions, attachedSkillIds, setAttachedSkillIds, enabledIntegrations, setEnabledIntegrations,
        knowledgeBaseIds, setKnowledgeBaseIds, toolsConfig, setToolsConfig, setModel, setSelectedTier, chatTier,
        setSavingState, setSavedAt, dirty, setDirty, setSaveErrorMsg, baseVersion, setBaseVersion, setLimitWarning,
        activeTab, skillPickerOpen, setSkillPickerOpen, setToolChooserOpen, setToolChooserAppId, setKnowledgeOpen,
        instructionsEditing, setInstructionsEditing, instructionsTextareaRef, actionBarRef, chat, setChat, chatInput,
        setChatInput, chatBusy, setChatBusy, chatScrollRef, setRefining, setActiveTab,
    } = s;
    // An agent a Solution stage manages: the whole builder is read-only and the AI
    // refine rail is gone, except the audience (the header's capsule), which is the
    // one thing a stage leaves to its owner. The header reads `managed` itself.
    const managed = managedOf(agent);
    const ro = readOnly || forcedReadOnly || !!managed;
    const roRef = useRef(ro);
    useLayoutEffect(() => {
        roRef.current = ro;
    });

    const mountedRef = useMountedRef();
    useSkillPickerOutsideClose(skillPickerOpen, setSkillPickerOpen, actionBarRef);

    // The Cowork items that run as this agent — moved to builderSplit/useAgentSchedules.ts.
    const schedules = useAgentSchedules(agent?.id);

    // Bootstrap data (skills, integration status, categories, org groups,
    // tiers, automations): from the shared AgentEditorBootstrapProvider, or the
    // standalone six-request fallback — moved to builderSplit/useAgentBootstrapData.ts.
    const boot = useAgentBootstrapData();
    const { bootstrap, allSkills, setAllSkills, integrationStatus, tiers, setCategories } = boot;

    // Chat scroll, tier pill, save snapshot (`stateRef`) and focus effects —
    // moved to builderSplit/useEditorEffects.ts.
    const { stateRef, agentIdRef, dirtyRef } = useEditorSync({
        initialAgent, plan, agent, name, instructions, description, instructionsEditing, instructionsTextareaRef,
        chat, chatScrollRef, setSelectedTier,
    });

    // Re-read the agent and rehydrate the editor (version restore, "Load
    // latest", undo of a refine) — moved to builderSplit/versionRestore.ts.
    // `save.hookMarkSaved` comes from the save pipeline below and is read at call time.
    const handleVersionRestore = createVersionRestore({
        getAgentId: () => agent?.id, stateRef, dirtyRef, setAgent, setName, setDescription, setInstructions,
        setAvatar, setModel, setSelectedTier, setToolsConfig, setEnabledIntegrations, setAttachedSkillIds,
        setKnowledgeBaseIds, setDirty, setBaseVersion, setSavingState, setSavedAt,
        markSaved: (updated, version) => save.hookMarkSaved(updated, version),
    });

    // The save pipeline (snapshot, autosave, first save of a draft, publish-version,
    // 409 reconcile, unload beacon) — moved to builderSplit/useAgentSave.ts.
    const save = useAgentSave({
        agent, setAgent, ro, roRef, mountedRef, stateRef, agentIdRef, dirtyRef, dirty, setDirty,
        baseVersion, setBaseVersion, setForcedReadOnly, setInstructions, setLimitWarning, setChat,
        setSavingState, setSaveErrorMsg, setSavedAt, onDirtyChange, onPublished, handleVersionRestore,
    });
    const { queueSave, flush } = save;

    // Edit handlers: fields, categories, behaviour toggles, publishing and
    // knowledge-base links — moved to builderSplit/useEditorActions.ts.
    const actions = useEditorActions({ s, stateRef, dirtyRef, agentIdRef, queueSave, flush, bootstrap, setCategories });
    const { patchConfig, allKbs, kbsState } = actions;

    // The "Upload files" pill shows what the Files dialog calls "Documents
    // (N)": the documents of the base it uploads into. The dialog reports its
    // own total whenever it reads the list; until then the knowledge-base
    // list's count stands in (BFSF-392).
    const [reportedDocCount, setReportedDocCount] = useState<ReportedDocCount | null>(null);
    const onDocCountChange = useCallback((kbId: string, total: number) => setReportedDocCount({ kbId, total }), []);
    const uploadDocCount = uploadDocCountOf({
        uploadKbId: uploadKbIdOf(agent, knowledgeBaseIds),
        kbs: allKbs,
        kbsReadable: kbsState === READ.OK,
        reported: reportedDocCount,
    });

    // The "Can use" tab (A2 steps 2-4): sources, rows and grant mutations —
    // moved to builderSplit/useCanUseTab.ts; its rows go to CanUseTabPanel as is.
    const canUse = useCanUseTab({
        activeTab, setActiveTab, agent, toolsConfig, setToolsConfig, enabledIntegrations, setEnabledIntegrations,
        attachedSkillIds, knowledgeBaseIds, allKbs, kbsState, allSkills, automations: boot.automations, stateRef, patchConfig,
        setKnowledgeOpen, setSkillPickerOpen, setToolChooserOpen, setToolChooserAppId,
    });
    const { datatableGrantCount, automationGrantCount } = canUse;

    // De testset (A4 deel D). Zelfde vorm als de kaarten hierboven: de lezing
    // gaat pas de deur uit als de tab open staat, en een mislukte lezing komt
    // als zodanig op de kaart — nooit als "nog nooit gedraaid".
    const testSet = useAgentTests({
        enabled: activeTab === AGENT_TAB_IDS.TEST,
        agentId: agent?.id || null,
    });

    // Flush on blur for typed fields — guarantees the change lands as soon
    // as the user leaves the field, even if they click immediately to nav away.
    const flushNow = () => { if (dirtyRef.current) flush(); };

    // Integrations, tab counters, "Used by" read and persona language —
    // moved to builderSplit/useEditorDerived.ts.
    const derived = useEditorDerived({
        t, agent, integrationStatus, allSkills, enabledIntegrations, knowledgeBaseIds, attachedSkillIds,
        datatableGrantCount, automationGrantCount,
    });
    const { availableIntegrations, skillNamesById, conceptFacts } = derived;

    // The refine-chat pipeline — moved verbatim to builderSplit/refineActions.js.
    const handleRefine = createHandleRefine({
        chat, setChat, chatInput, setChatInput, chatBusy, setChatBusy, setRefining, setInstructionsEditing,
        dirtyRef, flush, attachedSkillIds, setAttachedSkillIds, skillNamesById, name, setName, description,
        setDescription, avatar, setAvatar, setInstructions, setModel, setSelectedTier, setEnabledIntegrations,
        setKnowledgeBaseIds, stateRef, plan, chatTier, tier, locale, t, allSkills, setAllSkills,
        availableIntegrations, tiers, queueSave, schedulesAllowed: schedules.schedulesAllowed, agent, refreshAgentSchedules: schedules.refreshAgentSchedules,
        // De persona zoals hij in de kolom staat. Onbekend blijft undefined:
        // de merge leest dat als "laat staan", niet als "er is er geen".
        currentPersona: agent?.persona ?? conceptFacts.persona ?? undefined,
        // …en dit is het enige geval waarin "er is er geen" wél waar is: er is
        // nog helemaal geen agentrij, dus er valt niets te beschermen en de
        // verfijning schrijft de eerste versie. Zodra er een id is, betekent
        // een ontbrekende persona "niet gelezen" (de lijstroute strippt de
        // kolom en `?draft=1` kan 403'en) en blijft de kolom staan.
        noStoredPersona: !agent?.id,
    });

    // "Undo" on a Done turn: restore of the pre_refine row, flush first —
    // moved to builderSplit/undoRefine.ts.
    const handleUndoRefine = createUndoRefine({ roRef, agentIdRef, mountedRef, setChat, flush, handleVersionRestore });

    // When the wizard handed us off mid-conversation (user typed a refine
    // message on the landing screen), auto-fire it here so the response
    // appears in the builder chat — not back in the wizard.
    const initialRefinementFiredRef = useRef(false);
    const fireInitialRefinement = useEffectEvent(() => handleRefine(initialRefinement));
    useEffect(() => {
        if (initialRefinementFiredRef.current) return;
        if (typeof initialRefinement !== 'string' || !initialRefinement.trim()) return;
        initialRefinementFiredRef.current = true;
        fireInitialRefinement();
    }, [initialRefinement]);

    // The tool chooser stays here: ToolChooser is JS, its props cannot be typed in a .tsx file.
    const toolChooser = s.toolChooserOpen && (
        <ToolChooser
            t={t}
            ro={ro}
            open
            focusAppId={s.toolChooserAppId}
            apps={canUse.catalogApps}
            catalogState={canUse.catalogState}
            catalogDegraded={canUse.catalogDegraded}
            onRetryCatalog={canUse.refetchCatalog}
            labels={canUse.integrationLabels}
            toolsConfig={toolsConfig}
            enabledIntegrations={enabledIntegrations}
            onCommit={canUse.onCommitTools}
            onClose={() => { setToolChooserOpen(false); setToolChooserAppId(null); }}
        />
    );

    // Chat-panel resize — moved verbatim to builderSplit/useChatPanelResize.js.
    const { chatWidth, onDragStart } = useChatPanelResize();

    return (
        <BuilderView
            t={t} ro={ro} headerRo={readOnly || forcedReadOnly} rel={rel} user={user} locale={locale} onNavigate={onNavigate}
            onBack={onBack} rightHeaderExtras={rightHeaderExtras} s={s} actions={actions} canUse={canUse} save={save}
            boot={boot} derived={derived} schedules={schedules} testSet={testSet} uploadDocCount={uploadDocCount}
            onDocCountChange={onDocCountChange} flushNow={flushNow} handleRefine={handleRefine} toolChooser={toolChooser}
            handleUndoRefine={handleUndoRefine} handleVersionRestore={handleVersionRestore} mountedRef={mountedRef}
            chatWidth={chatWidth} onDragStart={onDragStart}
        />
    );
}


// The former in-file helper components (InstructionsEditor,
// EnableEmbedConfirmModal, SaveStateIndicator, ActionPill, the schedule
// delete modal) and the extracted handler factories/hooks live in
// ./builderSplit/. Schedule-picker constants and components moved to
// ./pickers/SchedulePickers.jsx.
