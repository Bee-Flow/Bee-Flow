import { useRef, useState } from 'react';
import { AGENT_TAB_IDS } from './AgentEditorHeader';
import type { ChatMessage } from '../agentEditor.types';
import type { LimitWarning } from '@/api/agentSaveTypes';
import type { EditorAgent, EditorPlan } from './editorTypes';
import type { ScheduleDeleteTarget } from './ScheduleDeleteModal';
import type { Schedule } from './useAgentSchedules';
import { pickAgentAvatar, DEFAULT_AGENT_EMOJI } from '@/utils/agentAvatar';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The JSON array a column may hold as an array or as a JSON string. */
function jsonListOf(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
    return [];
}

/**
 * Every `useState` of the agent editor (BuilderSplit), seeded from the loaded
 * agent or the wizard's plan. State only: no effects and no handlers, so the
 * hook order inside is irrelevant to behaviour; BuilderSplit passes the
 * returned values on to the hooks that act on them.
 */
export default function useBuilderState(initialAgent: EditorAgent | null | undefined, plan: EditorPlan | null | undefined, history: ChatMessage[] | undefined, t: TranslateFn) {
    const [agent, setAgent] = useState<EditorAgent | null | undefined>(initialAgent);
    // BFSF-271: read-only mode. `readOnly` comes from the server's per-agent
    // can_edit verdict; `forcedReadOnly` flips on when a save is rejected with
    // code 'agent_not_editable' (stale client) so we never retry-loop a 403.
    const [forcedReadOnly, setForcedReadOnly] = useState(false);
    const [name, setName] = useState<string>(initialAgent?.name || plan?.name || t('agent_wizard.builder.name_placeholder'));
    const [avatar, setAvatar] = useState<string>(pickAgentAvatar(initialAgent) || plan?.avatar || DEFAULT_AGENT_EMOJI);
    const [description, setDescription] = useState<string>(initialAgent?.description || plan?.description || '');
    const [instructions, setInstructions] = useState<string>(initialAgent?.system_prompt || plan?.systemPrompt || '');
    const [model, setModel] = useState<string>(initialAgent?.model || '');
    const [categoryId, setCategoryId] = useState<string | null>(initialAgent?.category_id || null);
    const [isPublished, setIsPublished] = useState<boolean>(initialAgent?.is_published === 1 || initialAgent?.is_published === true);
    const [sharedGroups, setSharedGroups] = useState<string[]>(() => jsonListOf(initialAgent?.shared_groups));

    // Canonical config fields (round-trip with AgentEditorUI)
    const [memoryEnabled, setMemoryEnabled] = useState<boolean>(!!initialAgent?.config?.memoryEnabled);
    // When per-agent memory is enabled, this flag controls whether the agent
    // also reads from the user's general memory. Default true (read but don't
    // write to general memory). False = fully isolated bucket.
    const [useGeneralMemory, setUseGeneralMemory] = useState<boolean>(initialAgent?.config?.useGeneralMemory !== false);
    const [attachedSkillIds, setAttachedSkillIds] = useState<string[]>(initialAgent?.config?.attachedSkillIds || []);
    // New agents are created with `enabledIntegrations: []` (none enabled).
    // Legacy agents may have `null`, which historically means "all available
    // are enabled" — we preserve that contract so chat tools don't disappear
    // until the user explicitly customises the list.
    const [enabledIntegrations, setEnabledIntegrations] = useState<string[] | null>(
        initialAgent?.config?.enabledIntegrations === undefined ? [] : initialAgent?.config?.enabledIntegrations ?? null
    );
    const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>(initialAgent?.config?.knowledge_base_ids || []);
    // The per-action grants (A1b). They sit NEXT TO `enabledIntegrations`, which
    // stays the app-level on/off list — mobile and `isAppOn` read that one, and
    // the two must not drift into each other. See canUse/toolGrants.js for the
    // rule that governs this map: an app that is NOT in it keeps everything.
    const [toolsConfig, setToolsConfig] = useState<Record<string, unknown> | null>(initialAgent?.config?.tools ?? null);
    const [strictKnowledge, setStrictKnowledge] = useState<boolean>(!!initialAgent?.config?.strictKnowledge);
    const [includeSourceReferences, setIncludeSourceReferences] = useState<boolean>(!!initialAgent?.config?.includeSourceReferences);
    // Behavior toggles
    const [allowCopy, setAllowCopy] = useState<boolean>(initialAgent?.config?.allowCopy !== false);
    const [embedEnabled, setEmbedEnabled] = useState<boolean>(initialAgent?.embed_enabled === 1 || initialAgent?.embed_enabled === true);
    const [disableExternalTools, setDisableExternalTools] = useState<boolean>(initialAgent?.config?.disableExternalTools === true);
    // Bubble widget (subset of most-used)
    // Default bubble color is a neutral mid-grey — the original `#6366F1`
    // (indigo) is on the user-banned-purple list. Users can still pick any
    // color via the bubble color picker; we just don't *default* to purple.
    const [bubbleColor, setBubbleColor] = useState<string>(initialAgent?.config?.bubbleColor || '#6b7280');
    const [bubblePosition, setBubblePosition] = useState<string>(initialAgent?.config?.bubblePosition || 'right');
    const [bubbleIcon, setBubbleIcon] = useState<string>(initialAgent?.config?.bubbleIcon || '💬');

    // Tier (for chat input)
    const [selectedTier, setSelectedTier] = useState('fast');
    // Separate tier for the chat/refine panel — does not affect the saved agent model.
    const [chatTier, setChatTier] = useState('fast');

    const [savingState, setSavingState] = useState<string>(() => initialAgent?.updated_at ? 'saved' : 'idle');
    const [savedAt, setSavedAt] = useState<Date | null>(() => initialAgent?.updated_at ? new Date(initialAgent.updated_at) : null);
    // Mirror of dirtyRef as state, so the parent's onDirtyChange callback fires
    // synchronously when the user edits an unsaved draft (where auto-save is
    // disabled and dirtyRef wouldn't otherwise propagate up).
    const [dirty, setDirty] = useState(false);
    // Last save-error message (server response body or fetch error). Surfaced
    // in the save-state pill's title / tooltip so users see what went wrong
    // instead of a silent "Save error" with no context.
    const [saveErrorMsg, setSaveErrorMsg] = useState('');
    // Plan-limit warning (e.g. "reached its limit of 5 agents"). Surfaced as a
    // prominent dismissible banner with an upgrade CTA — never just a console
    // error — so the user understands why the save was blocked.
    const [limitWarning, setLimitWarning] = useState<LimitWarning | null>(null);
    // Optimistic-concurrency version token. Seeded from the loaded agent's `rev`;
    // advanced on every successful save. null = unguarded (first save of an agent
    // loaded before the rev column existed) — the response returns a real rev.
    const [baseVersion, setBaseVersion] = useState<number | null>(() => typeof initialAgent?.rev === 'number' && Number.isInteger(initialAgent.rev) ? initialAgent.rev : null);
    // A refine is applying the AI's plan — locks the instructions editor and
    // marks the whole refine as one atomic operation (one save at the end).
    const [refining, setRefining] = useState(false);

    // The four tabs of the header (AgentEditorHeader). The content of each tab
    // hangs below; the counters are computed further on, where the sources
    // they count are known.
    const [activeTab, setActiveTab] = useState<string>(AGENT_TAB_IDS.ROLE);

    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [appsPickerOpen, setAppsPickerOpen] = useState(false);
    // The tool chooser of A2 step 4: which ACTIONS of an app this agent may use.
    // `toolChooserAppId` is the app it opens on (the arrow of a row).
    const [toolChooserOpen, setToolChooserOpen] = useState(false);
    const [toolChooserAppId, setToolChooserAppId] = useState<string | null>(null);
    const [knowledgeOpen, setKnowledgeOpen] = useState(false);
    const [schedulesPickerOpen, setSchedulesPickerOpen] = useState(false);
    const [scheduleModal, setScheduleModal] = useState<{ mode: 'create' } | { mode: 'edit'; schedule: Schedule } | null>(null);
    const [scheduleDeleteTarget, setScheduleDeleteTarget] = useState<ScheduleDeleteTarget | null>(null);
    const [scheduleDeleting, setScheduleDeleting] = useState(false);
    const [publishPickerOpen, setPublishPickerOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [skillSearch, setSkillSearch] = useState('');
    const [instructionsEditing, setInstructionsEditing] = useState(false);
    const instructionsTextareaRef = useRef<HTMLTextAreaElement>(null);

    // Single ref on the action bar — all dropdown pickers are positioned
    // relative to it (top-full left-0), so one outside-click handler covers them all.
    const actionBarRef = useRef<HTMLDivElement>(null);

    const [chat, setChat] = useState<ChatMessage[]>(history || []);
    const [chatInput, setChatInput] = useState('');
    const [chatBusy, setChatBusy] = useState(false);
    const chatScrollRef = useRef<HTMLDivElement>(null);

    return {
        agent, setAgent, forcedReadOnly, setForcedReadOnly, name, setName, avatar, setAvatar, description, setDescription,
        instructions, setInstructions, model, setModel, categoryId, setCategoryId, isPublished, setIsPublished,
        sharedGroups, setSharedGroups, memoryEnabled, setMemoryEnabled, useGeneralMemory, setUseGeneralMemory,
        attachedSkillIds, setAttachedSkillIds, enabledIntegrations, setEnabledIntegrations, knowledgeBaseIds, setKnowledgeBaseIds,
        toolsConfig, setToolsConfig, strictKnowledge, setStrictKnowledge, includeSourceReferences, setIncludeSourceReferences,
        allowCopy, setAllowCopy, embedEnabled, setEmbedEnabled, disableExternalTools, setDisableExternalTools,
        bubbleColor, setBubbleColor, bubblePosition, setBubblePosition, bubbleIcon, setBubbleIcon,
        selectedTier, setSelectedTier, chatTier, setChatTier,
        savingState, setSavingState, savedAt, setSavedAt, dirty, setDirty, saveErrorMsg, setSaveErrorMsg,
        limitWarning, setLimitWarning, baseVersion, setBaseVersion, refining, setRefining,
        activeTab, setActiveTab, skillPickerOpen, setSkillPickerOpen, appsPickerOpen, setAppsPickerOpen,
        toolChooserOpen, setToolChooserOpen, toolChooserAppId, setToolChooserAppId, knowledgeOpen, setKnowledgeOpen,
        schedulesPickerOpen, setSchedulesPickerOpen, scheduleModal, setScheduleModal,
        scheduleDeleteTarget, setScheduleDeleteTarget, scheduleDeleting, setScheduleDeleting,
        publishPickerOpen, setPublishPickerOpen, advancedOpen, setAdvancedOpen, skillSearch, setSkillSearch,
        instructionsEditing, setInstructionsEditing, instructionsTextareaRef, actionBarRef,
        chat, setChat, chatInput, setChatInput, chatBusy, setChatBusy, chatScrollRef,
    };
}
