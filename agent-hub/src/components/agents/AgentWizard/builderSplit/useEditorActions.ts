import { useCallback } from 'react';
import { createCategoryActions, createFieldUpdaters, createPublishActions } from './builderSplitActions';
import type { Ref, Setter, EditorSnapshot } from '../../../../api/agentSaveTypes';
import type { CategoryRow } from '../agentEditor.types';
import type useBuilderState from './useBuilderState';
import useBehaviorToggles from './useBehaviorToggles';
import useKnowledgeBases from './useKnowledgeBases';

type BuilderState = ReturnType<typeof useBuilderState>;

interface Inputs {
    s: BuilderState;
    stateRef: Ref<EditorSnapshot>;
    dirtyRef: Ref<boolean>;
    agentIdRef: Ref<string | null | undefined>;
    queueSave: (immediate?: boolean) => void;
    flush: () => unknown;
    bootstrap: { refreshCategories?: () => unknown };
    setCategories: Setter<CategoryRow[]>;
}

/**
 * The edit handlers of the agent editor, wired to the editor state: field
 * updaters (typing debounced, discrete actions saved at once), category CRUD,
 * the behaviour toggles with the embed-enable confirm gate, publishing and
 * knowledge-base linking. The call order of the hooks inside is the order the
 * editor always had; the state stays on the editor's fiber (`s`).
 */
export default function useEditorActions({ s, stateRef, dirtyRef, agentIdRef, queueSave, flush, bootstrap, setCategories }: Inputs) {
    const patchConfig = useCallback((patch: Record<string, unknown>, { immediate = true } = {}) => {
        stateRef.current.config = { ...stateRef.current.config, ...patch };
        queueSave(immediate);
    }, [queueSave, stateRef]);

    const updateBubbleColor = (v: string) => { s.setBubbleColor(v); patchConfig({ bubbleColor: v }); };
    const updateBubblePosition = (v: string) => { s.setBubblePosition(v); patchConfig({ bubblePosition: v }); };
    const updateBubbleIcon = (v: string) => { s.setBubbleIcon(v); patchConfig({ bubbleIcon: v }); };

    // Field edit handlers (typing debounced; discrete actions save
    // immediately) — moved verbatim to builderSplit/builderSplitActions.js.
    const fieldUpdaters = createFieldUpdaters({
        setName: s.setName, setInstructions: s.setInstructions, setAvatar: s.setAvatar, memoryEnabled: s.memoryEnabled,
        setMemoryEnabled: s.setMemoryEnabled, useGeneralMemory: s.useGeneralMemory, setUseGeneralMemory: s.setUseGeneralMemory,
        attachedSkillIds: s.attachedSkillIds, setAttachedSkillIds: s.setAttachedSkillIds, enabledIntegrations: s.enabledIntegrations,
        setEnabledIntegrations: s.setEnabledIntegrations, setKnowledgeBaseIds: s.setKnowledgeBaseIds,
        setStrictKnowledge: s.setStrictKnowledge, setIncludeSourceReferences: s.setIncludeSourceReferences,
        setDescription: s.setDescription, setModel: s.setModel, setSelectedTier: s.setSelectedTier, setCategoryId: s.setCategoryId,
        stateRef, dirtyRef, queueSave, patchConfig,
    });

    // BFSF-272 category CRUD for the CategoryField manage popover — moved
    // verbatim to builderSplit/builderSplitActions.js.
    const categoryActions = createCategoryActions({ setCategories, updateCategory: fieldUpdaters.updateCategory, bootstrap, stateRef, flush });

    // Behavior toggles (incl. the embed-enable confirm gate) — moved verbatim
    // to builderSplit/useBehaviorToggles.js; state stays on this fiber.
    const behaviorToggles = useBehaviorToggles({
        allowCopy: s.allowCopy, setAllowCopy: s.setAllowCopy, disableExternalTools: s.disableExternalTools,
        setDisableExternalTools: s.setDisableExternalTools, embedEnabled: s.embedEnabled, setEmbedEnabled: s.setEmbedEnabled,
        stateRef, dirtyRef, queueSave, patchConfig,
    });

    // Publishing (dedicated PATCH /agents/:id/publish endpoint) — moved
    // verbatim to builderSplit/builderSplitActions.js.
    const publishActions = createPublishActions({
        agentIdRef, isPublished: s.isPublished, sharedGroups: s.sharedGroups, setIsPublished: s.setIsPublished,
        setSharedGroups: s.setSharedGroups, setSaveErrorMsg: s.setSaveErrorMsg,
    });

    // Knowledge-base linking — moved verbatim to builderSplit/useKnowledgeBases.js.
    const knowledgeBases = useKnowledgeBases({ knowledgeBaseIds: s.knowledgeBaseIds, setKnowledgeBaseIds: s.setKnowledgeBaseIds, patchConfig });

    return { patchConfig, updateBubbleColor, updateBubblePosition, updateBubbleIcon, ...fieldUpdaters, ...categoryActions, ...behaviorToggles, ...publishActions, ...knowledgeBases };
}
