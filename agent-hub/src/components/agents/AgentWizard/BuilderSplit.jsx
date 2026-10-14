import React, { useState, useRef, useEffect, useEffectEvent, useCallback } from 'react';
import AgentConflictModal from './AgentConflictModal';
import { filterAvailableIntegrations } from '../AgentDesigner/integrationAvailability';
import { INTEGRATION_CATALOG } from '../AgentDesigner/integrations';
import AgentEditorHeader, { AGENT_TAB_IDS, buildAgentTabs, publishedVersionOf } from './builderSplit/AgentEditorHeader';
import AgentHero from './builderSplit/AgentHero';
import BuilderChatPanel from './builderSplit/BuilderChatPanel';
import BuilderConfigPanel from './builderSplit/BuilderConfigPanel';
import { createCategoryActions, createFieldUpdaters, createPublishActions } from './builderSplit/builderSplitActions';
import { CanUseTabPanel, LimitWarningBanner, TestTabPanel, UsedByTabPanel } from './builderSplit/BuilderTabPanels';
import EnableEmbedConfirmModal from './builderSplit/EnableEmbedConfirmModal';
import { createHandleRefine } from './builderSplit/refineActions';
import ScheduleDeleteModal from './builderSplit/ScheduleDeleteModal';
import { uploadDocCountOf, uploadKbIdOf } from './builderSplit/uploadKb';
import useAgentBootstrapData from './builderSplit/useAgentBootstrapData';
import useAgentConceptFacts from './builderSplit/useAgentConceptFacts';
import useAgentSave from './builderSplit/useAgentSave';
import useAgentSchedules from './builderSplit/useAgentSchedules';
import useBehaviorToggles from './builderSplit/useBehaviorToggles';
import useCanUseTab from './builderSplit/useCanUseTab';
import useChatPanelResize from './builderSplit/useChatPanelResize';
import useKnowledgeBases from './builderSplit/useKnowledgeBases';
import { createVersionRestore } from './builderSplit/versionRestore';
import { READ } from './canUse/canUseFacts';
import ToolChooser from './canUse/ToolChooser';
import AdvancedDrawer from './pickers/AdvancedDrawer';
import FilesUploadModal from './pickers/FilesUploadModal';
import { ScheduleModal } from './pickers/SchedulePickers';
import useAgentTests from './tests/useAgentTests';
import { agentUsageFetcher, restoreAgentVersion } from '../../../api/agentEditor';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import useUsage from '../../../hooks/useUsage';
import { pickAgentAvatar, DEFAULT_AGENT_EMOJI } from '../../../utils/agentAvatar';
import { managedOf } from '../../shared/managedPart';

export default function BuilderSplit({ agent: initialAgent, plan, history, tier, locale, onBack, onPublished, onDirtyChange, rightHeaderExtras = null, user = null, initialRefinement = null, readOnly = false, onNavigate = null }) {
    const { t } = useTranslation();
    // Relatieve tijd ("bijgewerkt gisteren") op de Kennis-kaart. De hook moet
    // hier staan — hij leest de vertaler — en wordt als functie doorgegeven,
    // zodat de kaart zelf puur blijft en zonder provider te testen is.
    const rel = useRelativeTime();

    const [agent, setAgent] = useState(initialAgent);
    // BFSF-271: read-only mode. `readOnly` comes from the server's per-agent
    // can_edit verdict; `forcedReadOnly` flips on when a save is rejected with
    // code 'agent_not_editable' (stale client) so we never retry-loop a 403.
    const [forcedReadOnly, setForcedReadOnly] = useState(false);
    // An agent a Solution stage manages: the whole builder is read-only and the AI
    // refine rail is gone, except the audience (the header's capsule), which is the
    // one thing a stage leaves to its owner. The header reads `managed` itself.
    const managed = managedOf(agent);
    const ro = readOnly || forcedReadOnly || !!managed;
    const headerRo = readOnly || forcedReadOnly;
    const roRef = useRef(ro);
    roRef.current = ro;
    const [name, setName] = useState(initialAgent?.name || plan?.name || t('agent_wizard.builder.name_placeholder'));
    const [avatar, setAvatar] = useState(pickAgentAvatar(initialAgent) || plan?.avatar || DEFAULT_AGENT_EMOJI);
    const [description, setDescription] = useState(initialAgent?.description || plan?.description || '');
    const [instructions, setInstructions] = useState(initialAgent?.system_prompt || plan?.systemPrompt || '');
    const [model, setModel] = useState(initialAgent?.model || '');
    const [categoryId, setCategoryId] = useState(initialAgent?.category_id || null);
    const [starterPrompts, setStarterPrompts] = useState(() => {
        const sp = initialAgent?.starter_prompts;
        if (Array.isArray(sp)) return sp;
        if (typeof sp === 'string') { try { return JSON.parse(sp); } catch { return []; } }
        return [];
    });
    const [isPublished, setIsPublished] = useState(initialAgent?.is_published === 1 || initialAgent?.is_published === true);
    const [sharedGroups, setSharedGroups] = useState(() => {
        const g = initialAgent?.shared_groups;
        if (Array.isArray(g)) return g;
        if (typeof g === 'string') { try { return JSON.parse(g); } catch { return []; } }
        return [];
    });

    // Canonical config fields (round-trip with AgentEditorUI)
    const [memoryEnabled, setMemoryEnabled] = useState(!!initialAgent?.config?.memoryEnabled);
    // When per-agent memory is enabled, this flag controls whether the agent
    // also reads from the user's general memory. Default true (read but don't
    // write to general memory). False = fully isolated bucket.
    const [useGeneralMemory, setUseGeneralMemory] = useState(initialAgent?.config?.useGeneralMemory !== false);
    const [attachedSkillIds, setAttachedSkillIds] = useState(initialAgent?.config?.attachedSkillIds || []);
    // New agents are created with `enabledIntegrations: []` (none enabled).
    // Legacy agents may have `null`, which historically means "all available
    // are enabled" — we preserve that contract so chat tools don't disappear
    // until the user explicitly customises the list.
    const [enabledIntegrations, setEnabledIntegrations] = useState(
        initialAgent?.config?.enabledIntegrations === undefined ? [] : initialAgent.config.enabledIntegrations
    );
    const [knowledgeBaseIds, setKnowledgeBaseIds] = useState(initialAgent?.config?.knowledge_base_ids || []);
    // De per-actie grants (A1b). Deze staan NAAST `enabledIntegrations`, dat de
    // app-niveau aan/uit-lijst blijft — mobile en `isAppOn` lezen die, en die
    // twee mogen niet door elkaar gaan lopen. Zie canUse/toolGrants.js voor de
    // regel die deze map bestuurt: een app die er NIET in staat houdt alles.
    const [toolsConfig, setToolsConfig] = useState(initialAgent?.config?.tools ?? null);
    const [strictKnowledge, setStrictKnowledge] = useState(!!initialAgent?.config?.strictKnowledge);
    const [includeSourceReferences, setIncludeSourceReferences] = useState(!!initialAgent?.config?.includeSourceReferences);
    // Behavior toggles
    const [allowCopy, setAllowCopy] = useState(initialAgent?.config?.allowCopy !== false);
    const [embedEnabled, setEmbedEnabled] = useState(initialAgent?.embed_enabled === 1 || initialAgent?.embed_enabled === true);
    const [threadsEnabled, setThreadsEnabled] = useState(initialAgent?.threads_enabled !== 0 && initialAgent?.threads_enabled !== false);
    const [workspaceEnabled, setWorkspaceEnabled] = useState(initialAgent?.workspace_enabled === 1 || initialAgent?.workspace_enabled === true);
    const [disableExternalTools, setDisableExternalTools] = useState(initialAgent?.config?.disableExternalTools === true);
    // Guardrails
    const [enableGuardrails, setEnableGuardrails] = useState(initialAgent?.config?.enableGuardrails === true);
    const [llamaGuardEnabled, setLlamaGuardEnabled] = useState(initialAgent?.config?.llamaGuardEnabled === true);
    const [webSearchGuardEnabled, setWebSearchGuardEnabled] = useState(initialAgent?.config?.webSearchGuardEnabled === true);
    // Bubble widget (subset of most-used)
    // Default bubble color is a neutral mid-grey — the original `#6366F1`
    // (indigo) is on the user-banned-purple list. Users can still pick any
    // color via the bubble color picker; we just don't *default* to purple.
    const [bubbleColor, setBubbleColor] = useState(initialAgent?.config?.bubbleColor || '#6b7280');
    const [bubblePosition, setBubblePosition] = useState(initialAgent?.config?.bubblePosition || 'right');
    const [bubbleIcon, setBubbleIcon] = useState(initialAgent?.config?.bubbleIcon || '💬');

    // Tier (for chat input)
    const [selectedTier, setSelectedTier] = useState('fast');
    // Separate tier for the chat/refine panel — does not affect the saved agent model.
    const [chatTier, setChatTier] = useState('fast');

    const [savingState, setSavingState] = useState(() => initialAgent?.updated_at ? 'saved' : 'idle');
    const [savedAt, setSavedAt] = useState(() => initialAgent?.updated_at ? new Date(initialAgent.updated_at) : null);
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
    const [limitWarning, setLimitWarning] = useState(null);
    // Optimistic-concurrency version token. Seeded from the loaded agent's `rev`;
    // advanced on every successful save. null = unguarded (first save of an agent
    // loaded before the rev column existed) — the response returns a real rev.
    const [baseVersion, setBaseVersion] = useState(() => Number.isInteger(initialAgent?.rev) ? initialAgent.rev : null);
    // A refine is applying the AI's plan — locks the instructions editor and
    // marks the whole refine as one atomic operation (one save at the end).
    const [refining, setRefining] = useState(false);

    // De vier tabs van de kop (AgentEditorHeader). De inhoud van elke tab
    // hangt hieronder; de tellers worden verderop berekend, waar de bronnen
    // die ze tellen bekend zijn.
    const [activeTab, setActiveTab] = useState(AGENT_TAB_IDS.ROLE);

    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [appsPickerOpen, setAppsPickerOpen] = useState(false);
    // De tool-kiezer van A2 stap 4: welke ACTIES van een app deze agent mag.
    // `toolChooserAppId` is de app waarop hij opengaat (de ↗ van een rij).
    const [toolChooserOpen, setToolChooserOpen] = useState(false);
    const [toolChooserAppId, setToolChooserAppId] = useState(null);
    const [knowledgeOpen, setKnowledgeOpen] = useState(false);
    const [schedulesPickerOpen, setSchedulesPickerOpen] = useState(false);
    const [scheduleModal, setScheduleModal] = useState(null); // null | { mode: 'create' } | { mode: 'edit', schedule }
    const [scheduleDeleteTarget, setScheduleDeleteTarget] = useState(null);
    const [scheduleDeleting, setScheduleDeleting] = useState(false);
    const [publishPickerOpen, setPublishPickerOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [skillSearch, setSkillSearch] = useState('');
    const [instructionsEditing, setInstructionsEditing] = useState(false);
    const instructionsTextareaRef = useRef(null);

    // Single ref on the action bar — all dropdown pickers are positioned
    // relative to it (top-full left-0), so one outside-click handler covers them all.
    const actionBarRef = useRef(null);

    // Mounted flag so async handlers can skip setState after unmount. Pair with
    // an AbortController fired on unmount so any new fetch initiated by the
    // editor (auto-save, draft create, knowledge picker bootstrap) can be wired
    // through it. Existing call sites that don't pass `signal:` still bail via
    // the mounted check before calling setState.
    const mountedRef = useRef(true);
    const unmountAbortRef = useRef(null);
    useEffect(() => {
        mountedRef.current = true;
        unmountAbortRef.current = new AbortController();
        return () => {
            mountedRef.current = false;
            try { unmountAbortRef.current?.abort(); } catch { /* noop */ }
        };
    }, []);

    useEffect(() => {
        const onDoc = (e) => {
            if (skillPickerOpen && actionBarRef.current && !actionBarRef.current.contains(e.target)) {
                setSkillPickerOpen(false);
            }
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [skillPickerOpen]);

    const updateBubbleColor = (v) => { setBubbleColor(v); patchConfig({ bubbleColor: v }); };
    const updateBubblePosition = (v) => { setBubblePosition(v); patchConfig({ bubblePosition: v }); };
    const updateBubbleIcon = (v) => { setBubbleIcon(v); patchConfig({ bubbleIcon: v }); };

    // The Cowork items that run as this agent — moved to builderSplit/useAgentSchedules.ts.
    const { schedulesAllowed, agentSchedules, refreshAgentSchedules } = useAgentSchedules(agent?.id);

    const [chat, setChat] = useState(history || []);
    const [chatInput, setChatInput] = useState('');
    const [chatBusy, setChatBusy] = useState(false);
    const chatScrollRef = useRef(null);

    // Stick to the bottom only when the user was already at (or near) the
    // bottom. If they've scrolled up to read history, don't yank them back —
    // that's why a user reading a long previous answer would lose their place
    // every time a new chunk streamed in.
    useEffect(() => {
        const el = chatScrollRef.current;
        if (!el) return;
        const STICK_THRESHOLD_PX = 80;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom <= STICK_THRESHOLD_PX) {
            el.scrollTop = el.scrollHeight;
        }
    }, [chat]);

    // Bootstrap data (skills, integration status, categories, org groups,
    // tiers, automations): from the shared AgentEditorBootstrapProvider, or the
    // standalone six-request fallback — moved to builderSplit/useAgentBootstrapData.ts.
    const {
        bootstrap, allSkills, setAllSkills, integrationStatus, tiers,
        categories, setCategories, categoriesState, orgGroups, automations,
    } = useAgentBootstrapData();

    useEffect(() => {
        // Sync the chat-input tier pill with the agent's persisted tier on mount
        // (and on agent switch — useEffect re-runs when initialAgent.id changes
        // because BuilderSplit is keyed by it in AgentStudio).
        if (initialAgent?.model && initialAgent.model.startsWith('tier:')) {
            setSelectedTier(initialAgent.model.slice('tier:'.length));
        }
    }, [initialAgent?.id, initialAgent?.model]);

    // ── Save pipeline ─────────────────────────────────────────────
    // The PUT /agents/:id endpoint writes columns from whatever it receives
    // and falls back to NULL for description / systemPrompt when absent.
    // So every save MUST send the full canonical state. We keep the latest
    // values in a ref to coalesce rapid edits without stale closures.
    const stateRef = useRef({
        name,
        description: initialAgent?.description || plan?.description || '',
        systemPrompt: instructions,
        model: initialAgent?.model || '',
        categoryId: initialAgent?.category_id || null,
        embedEnabled: initialAgent?.embed_enabled === 1 || initialAgent?.embed_enabled === true,
        avatar: pickAgentAvatar(initialAgent) || plan?.avatar || DEFAULT_AGENT_EMOJI,
        config: { ...(initialAgent?.config || {}) },
    });
    useEffect(() => { stateRef.current.name = name; }, [name]);
    useEffect(() => { stateRef.current.systemPrompt = instructions; }, [instructions]);
    useEffect(() => { stateRef.current.description = description; }, [description]);
    useEffect(() => {
        if (instructionsEditing && instructionsTextareaRef.current) {
            const el = instructionsTextareaRef.current;
            el.focus();
            const len = el.value.length;
            el.setSelectionRange(len, len);
        }
    }, [instructionsEditing]);

    const agentIdRef = useRef(agent?.id);
    useEffect(() => { agentIdRef.current = agent?.id; }, [agent?.id]);

    // Local dirty flag — drives the parent's unsaved-changes guard and the
    // best-effort beforeunload beacon. The autosave hook keeps its OWN dirty
    // flag for the save loop; this one is UX-only.
    const dirtyRef = useRef(false);

    // Re-read the agent and rehydrate the editor (version restore, "Load
    // latest", undo of a refine) — moved to builderSplit/versionRestore.ts.
    // `hookMarkSaved` comes from the save pipeline below and is read at call time.
    const handleVersionRestore = createVersionRestore({
        getAgentId: () => agent?.id, stateRef, dirtyRef, setAgent, setName, setDescription, setInstructions,
        setAvatar, setModel, setSelectedTier, setToolsConfig, setEnabledIntegrations, setAttachedSkillIds,
        setKnowledgeBaseIds, setDirty, setBaseVersion, setSavingState, setSavedAt,
        markSaved: (updated, version) => hookMarkSaved(updated, version),
    });

    // The save pipeline (snapshot, autosave, first save of a draft, publish-version,
    // 409 reconcile, unload beacon) — moved to builderSplit/useAgentSave.ts.
    const {
        queueSave, flush, hookMarkSaved, publishVersion, saveDraft,
        conflict, conflictBusy, publishing,
        handleConflictLoadLatest, handleConflictOverwrite, handleConflictDismiss,
    } = useAgentSave({
        agent, setAgent, ro, roRef, mountedRef, stateRef, agentIdRef, dirtyRef, dirty, setDirty,
        baseVersion, setBaseVersion, setForcedReadOnly, setInstructions, setLimitWarning, setChat,
        setSavingState, setSaveErrorMsg, setSavedAt, onDirtyChange, onPublished, handleVersionRestore,
    });

    const patchConfig = useCallback((patch, { immediate = true } = {}) => {
        stateRef.current.config = { ...stateRef.current.config, ...patch };
        queueSave(immediate);
    }, [queueSave]);

    // Field edit handlers (typing debounced; discrete actions save
    // immediately) — moved verbatim to builderSplit/builderSplitActions.js.
    const { updateName, updateInstructions, updateAvatar, toggleMemory, toggleUseGeneralMemory, toggleSkill, toggleIntegration, onKnowledgeBaseIdsChange, onStrictKnowledgeChange, onIncludeSourceReferencesChange, updateDescription, updateModel, updateCategory } = createFieldUpdaters({
        setName, setInstructions, setAvatar, memoryEnabled, setMemoryEnabled, useGeneralMemory, setUseGeneralMemory,
        attachedSkillIds, setAttachedSkillIds, enabledIntegrations, setEnabledIntegrations, setKnowledgeBaseIds,
        setStrictKnowledge, setIncludeSourceReferences, setDescription, setModel, setSelectedTier, setCategoryId,
        stateRef, dirtyRef, queueSave, patchConfig,
    });

    // BFSF-272 category CRUD for the CategoryField manage popover — moved
    // verbatim to builderSplit/builderSplitActions.js.
    const { createCategory, renameCategory, deleteCategory } = createCategoryActions({ setCategories, updateCategory, bootstrap, stateRef, flush });

    // Behavior toggles (incl. the embed-enable confirm gate) — moved verbatim
    // to builderSplit/useBehaviorToggles.js; state stays on this fiber.
    const { toggleAllowCopy, toggleDisableExternalTools, pendingEmbedEnable, toggleEmbedEnabled, confirmEnableEmbed, cancelEnableEmbed } = useBehaviorToggles({
        allowCopy, setAllowCopy, disableExternalTools, setDisableExternalTools, embedEnabled, setEmbedEnabled,
        stateRef, dirtyRef, queueSave, patchConfig,
    });

    // Publishing (dedicated PATCH /agents/:id/publish endpoint) — moved
    // verbatim to builderSplit/builderSplitActions.js.
    const { setPublishPersonal, setPublishEntireOrg, togglePublishGroup } = createPublishActions({ agentIdRef, isPublished, sharedGroups, setIsPublished, setSharedGroups, setSaveErrorMsg });

    // Knowledge-base linking — moved verbatim to builderSplit/useKnowledgeBases.js.
    const { toggleKbLink, allKbs, kbsState, refreshKbs, createKb } = useKnowledgeBases({ knowledgeBaseIds, setKnowledgeBaseIds, patchConfig });
    // The "Upload files" pill shows what the Files dialog calls "Documents
    // (N)": the documents of the base it uploads into. The dialog reports its
    // own total whenever it reads the list; until then the knowledge-base
    // list's count stands in (BFSF-392).
    const [reportedDocCount, setReportedDocCount] = useState(null);
    const onDocCountChange = useCallback((kbId, total) => setReportedDocCount({ kbId, total }), []);
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
        attachedSkillIds, knowledgeBaseIds, allKbs, kbsState, allSkills, automations, stateRef, patchConfig,
        setKnowledgeOpen, setSkillPickerOpen, setToolChooserOpen, setToolChooserAppId,
    });
    const {
        datatableGrantCount, automationGrantCount, integrationLabels,
        catalogApps, catalogState, catalogDegraded, refetchCatalog, onCommitTools,
    } = canUse;


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

    // Filter integration catalog by org/credential gating (shared with the
    // skill editor — see AgentDesigner/integrationAvailability.js).
    const availableIntegrations = filterAvailableIntegrations(INTEGRATION_CATALOG, integrationStatus);

    const skillNamesById = new Map((allSkills || []).map(s => [s.id, s]));
    // Apps are off by default (R4). Legacy `null` rows have been backfilled
    // server-side, so `enabledIntegrations` is always an array here.
    const enabledIntegrationCount = Array.isArray(enabledIntegrations)
        ? enabledIntegrations.filter(id => availableIntegrations.some(a => a.id === id)).length
        : 0;

    // ── De tellers op de tabs ─────────────────────────────────────
    // "Kan gebruiken": de apps die deze agent aan heeft staan, gemeten tegen
    // de catalogus die voor DEZE gebruiker beschikbaar is. Zolang die
    // catalogus niet gelezen is (integrationStatus === null) is het antwoord
    // onbekend — en dan toont de tab geen teller, geen 0. Onthoud dat
    // filterAvailableIntegrations bij een null-status de HELE catalogus
    // teruggeeft: zonder deze bewaking zou een mislukte lezing als een
    // gemeten getal op het scherm komen.
    // Sinds A2 stap 2 draagt de tab meer dan apps: kennisbanken, tabel-grants
    // en skills staan er ook op, en een teller die alleen apps telt zou
    // "3" zeggen boven een scherm met acht rijen. Alle vier komen uit de
    // CONFIG van de agent — geen van de extra lezingen van de tab is ervoor
    // nodig, dus de teller blijft kloppen terwijl je op Rol staat.
    const canUseCount = integrationStatus === null
        ? undefined
        : enabledIntegrationCount + knowledgeBaseIds.length + datatableGrantCount
            + attachedSkillIds.length + automationGrantCount;

    // "Gebruikt door": GET /agents/:id/usage. De URL-tabel van useUsage wijst
    // naar /api/agents/:id/usage, en die mount bestaat niet — de agents-router
    // hangt op /agents (server/index.js). Vandaar een eigen fetcher (agentUsageFetcher
    // in api/agentEditor.ts); zonder
    // die zou elke lezing een 404 zijn en de tab permanent "niet gelezen".
    const { usage: agentUsage, error: usageError, refetch: refetchUsage } = useUsage('agent', agent?.id || null, { fetcher: agentUsageFetcher });
    // Een mislukte lezing laat useUsage op [] landen MET een error ernaast.
    // Die [] mag nooit als "niemand gebruikt dit" op het scherm komen, dus de
    // teller is dan onbekend — niet 0.
    const usedByCount = usageError ? undefined : (Array.isArray(agentUsage) ? agentUsage.length : undefined);

    const tabs = buildAgentTabs(t, { canUseCount, usedByCount });

    // De conceptweergave draagt de persona (en dus de taal); de agentenlijst
    // waaruit de editor geopend wordt niet. Zie useAgentConceptFacts.
    const conceptFacts = useAgentConceptFacts(agent?.id || null);
    const personaLanguage = agent?.persona?.language ?? conceptFacts.persona?.language ?? null;
    const publishedVersion = publishedVersionOf(agent);

    // The refine-chat pipeline — moved verbatim to builderSplit/refineActions.js.
    const handleRefine = createHandleRefine({
        chat, setChat, chatInput, setChatInput, chatBusy, setChatBusy, setRefining, setInstructionsEditing,
        dirtyRef, flush, attachedSkillIds, setAttachedSkillIds, skillNamesById, name, setName, description,
        setDescription, avatar, setAvatar, setInstructions, setModel, setSelectedTier, setEnabledIntegrations,
        setKnowledgeBaseIds, stateRef, plan, chatTier, tier, locale, t, allSkills, setAllSkills,
        availableIntegrations, tiers, queueSave, schedulesAllowed, agent, refreshAgentSchedules,
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

    /**
     * "Ongedaan maken" op een Gedaan-beurt: een restore van de pre_refine-rij
     * die de verfijning vóór de merge schreef. Eén niveau diep — de rail biedt
     * de knop alleen op de nieuwste beurt aan, en de kaart zegt bij de oudere
     * waarom niet.
     *
     * Volgorde is hier het hele punt: eerst de lopende opslag legen, dan
     * herstellen, dan de agent opnieuw inlezen. Zonder die flush kan een
     * uitgestelde opslag van de VERFIJNDE staat ná de restore landen en hem
     * meteen weer ongedaan maken — precies de knop die niets doet.
     */
    const handleUndoRefine = async (index, versionId) => {
        // De version-id komt VAN DE KAART mee. Hem uit de chat-state vissen via
        // een setChat-updater zou werken zolang React de updater direct
        // uitrekent, en dat is een optimalisatie, geen belofte.
        if (roRef.current || !agentIdRef.current || !versionId) return;
        setChat(prev => {
            const m = prev[index];
            if (!m || m.role !== 'done' || m.undoState === 'busy' || m.undoState === 'undone') return prev;
            const next = [...prev];
            next[index] = { ...m, undoState: 'busy' };
            return next;
        });
        const finish = (state) => {
            if (!mountedRef.current) return;
            setChat(prev => {
                const m = prev[index];
                if (!m || m.role !== 'done') return prev;
                const next = [...prev];
                next[index] = { ...m, undoState: state };
                return next;
            });
        };
        try {
            try { await flush(); } catch { /* best effort — de restore is de waarheid */ }
            const res = await restoreAgentVersion(agentIdRef.current, versionId);
            if (!res.ok) { finish('failed'); return; }
            await handleVersionRestore();
            finish('undone');
        } catch {
            finish('failed');
        }
    };

    // "Test met een vraag" — de Gedaan-beurt wijst naar de Testen-tab.
    const handleTestAgent = () => setActiveTab(AGENT_TAB_IDS.TEST);

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

    // Flush any pending or in-flight save, then close.
    const handleDone = async () => {
        await flush();
        if (onPublished) onPublished(agent);
    };

    // Chat-panel resize — moved verbatim to builderSplit/useChatPanelResize.js.
    const { chatWidth, onDragStart } = useChatPanelResize();

    return (
        // Kop bovenaan, daaronder de inhoud met de verfijn-rail RECHTS
        // (A2 stap 1). De kop is GEEN onderdeel van de scrollende kolom: de
        // tabs, de capsule en de publiceerknop moeten in beeld blijven.
        <div className="flex flex-col h-full min-h-0">
            {/* Plan-limit warning — a prominent, dismissible banner shown when a
                save is blocked by the org's subscription limits (e.g. max agents).
                Replaces the silent console error so the user can act on it. */}
            {limitWarning && <LimitWarningBanner t={t} limitWarning={limitWarning} setLimitWarning={setLimitWarning} />}

            {/* De gedeelde Studio-kop. Bewust NIET inert bij alleen-lezen: de
                terugpijl en de tabs moeten blijven werken voor iemand die de
                agent alleen mag bekijken (BFSF-271). */}
            <AgentEditorHeader
                t={t}
                ro={headerRo}
                agent={agent}
                name={name}
                avatar={avatar}
                onBack={onBack}
                onRename={(next) => { updateName(next); flush(); }}
                tabs={tabs}
                activeTab={activeTab}
                onTab={setActiveTab}
                savingState={savingState}
                savedAt={savedAt}
                saveErrorMsg={saveErrorMsg}
                onRetrySave={flush}
                saveDraft={saveDraft}
                publishedVersion={publishedVersion}
                onPublishVersion={publishVersion}
                publishing={publishing}
                capsuleOpen={publishPickerOpen}
                onCapsuleToggle={() => setPublishPickerOpen(v => !v)}
                onCapsuleClose={() => setPublishPickerOpen(false)}
                isPublished={isPublished}
                sharedGroups={sharedGroups}
                orgGroups={orgGroups}
                embedEnabled={embedEnabled}
                onSetPersonal={setPublishPersonal}
                onSetEntireOrg={setPublishEntireOrg}
                onToggleGroup={togglePublishGroup}
                extras={rightHeaderExtras}
            />

            <div className="flex flex-1 min-h-0">
                <main className="flex-1 min-w-0 overflow-y-auto">
                    <AgentHero
                        t={t}
                        ro={ro}
                        avatar={avatar}
                        updateAvatar={updateAvatar}
                        name={name}
                        updateName={updateName}
                        flushNow={flushNow}
                        description={description}
                        updateDescription={updateDescription}
                        tiers={tiers}
                        selectedTier={selectedTier}
                        language={personaLanguage}
                        locale={locale}
                        // De categorie hoort bij de identiteit ("Sales ▾"), niet
                        // bij de rol — A3 haalt hem van de Rol-tab weg, waar hij
                        // vóór de vijf rolkaarten stond.
                        categoryId={categoryId}
                        categories={categories}
                        categoriesState={categoriesState}
                        updateCategory={updateCategory}
                        createCategory={createCategory}
                        renameCategory={renameCategory}
                        deleteCategory={deleteCategory}
                    />

                    {activeTab === AGENT_TAB_IDS.ROLE && (
                        <BuilderConfigPanel
                            ro={ro} t={t} agent={agent}
                            flushNow={flushNow}
                            actionBarRef={actionBarRef} tiers={tiers} selectedTier={selectedTier} updateModel={updateModel}
                            enabledIntegrationCount={enabledIntegrationCount} appsPickerOpen={appsPickerOpen} setAppsPickerOpen={setAppsPickerOpen}
                            uploadDocCount={uploadDocCount} setKnowledgeOpen={setKnowledgeOpen}
                            strictKnowledge={strictKnowledge} onStrictKnowledgeChange={onStrictKnowledgeChange}
                            attachedSkillIds={attachedSkillIds} skillPickerOpen={skillPickerOpen} setSkillPickerOpen={setSkillPickerOpen}
                            schedulesAllowed={schedulesAllowed} agentSchedules={agentSchedules}
                            schedulesPickerOpen={schedulesPickerOpen} setSchedulesPickerOpen={setSchedulesPickerOpen}
                            advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen} memoryEnabled={memoryEnabled} embedEnabled={embedEnabled}
                            refreshAgentSchedules={refreshAgentSchedules} setScheduleModal={setScheduleModal} setScheduleDeleteTarget={setScheduleDeleteTarget}
                            allSkills={allSkills} setAllSkills={setAllSkills} automations={automations}
                            skillSearch={skillSearch} setSkillSearch={setSkillSearch} toggleSkill={toggleSkill}
                            setAttachedSkillIds={setAttachedSkillIds} patchConfig={patchConfig}
                            availableIntegrations={availableIntegrations} enabledIntegrations={enabledIntegrations} toggleIntegration={toggleIntegration}
                            refining={refining} instructionsEditing={instructionsEditing} setInstructionsEditing={setInstructionsEditing}
                            instructionsTextareaRef={instructionsTextareaRef} instructions={instructions} updateInstructions={updateInstructions}
                        />
                    )}

                    {/* "Kan gebruiken" — Kennis (stap 2), Skills (stap 2) en
                        Tools (stap 3). De tool-KIEZER erachter komt in stap 4;
                        de "+ Koppelen"- en ↗-knoppen wijzen tot dan naar de
                        pickers die vandaag bestaan (zie openChooser). */}
                    {activeTab === AGENT_TAB_IDS.CAN_USE && (
                        <CanUseTabPanel
                            t={t} ro={ro} rel={rel} onNavigate={onNavigate} allSkills={allSkills}
                            knowledgeBaseIds={knowledgeBaseIds} includeSourceReferences={includeSourceReferences}
                            onIncludeSourceReferencesChange={onIncludeSourceReferencesChange}
                            kbsState={kbsState} refreshKbs={refreshKbs} {...canUse}
                        />
                    )}

                    {activeTab === AGENT_TAB_IDS.TEST && <TestTabPanel t={t} ro={ro} rel={rel} agent={agent} testSet={testSet} />}

                    {activeTab === AGENT_TAB_IDS.USED_BY && (
                        <UsedByTabPanel t={t} user={user} usageError={usageError} refetchUsage={refetchUsage} agentUsage={agentUsage} />
                    )}
                </main>

                {/* Sleepgreep — links VAN de rail, dus naar links slepen maakt
                    de rail breder (useChatPanelResize side='right'). */}
                {!ro && (
                <div
                    onMouseDown={onDragStart}
                    data-testid="refine-rail-handle"
                    className="w-1 flex-shrink-0 cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors z-10"
                />
                )}

                {/* De verfijn-rail. Verborgen bij alleen-lezen: verfijnen
                    muteert de agent (BFSF-271). */}
                {!ro && (
                    <BuilderChatPanel
                        chatWidth={chatWidth}
                        t={t}
                        chatScrollRef={chatScrollRef}
                        chat={chat}
                        chatInput={chatInput}
                        setChatInput={setChatInput}
                        handleRefine={handleRefine}
                        chatBusy={chatBusy}
                        tiers={tiers}
                        chatTier={chatTier}
                        setChatTier={setChatTier}
                        onTestAgent={handleTestAgent}
                        onUndoRefine={handleUndoRefine}
                    />
                )}
            </div>

            {/* BFSF-270: no `agent?.id` gate — for unsaved drafts the pill used
                to flip knowledgeOpen and render NOTHING (a silent no-op). The
                server never required a saved agent: uploads are KB-scoped and
                the KB link is staged in stateRef.current.config, which the
                draft's first save persists. */}
            {knowledgeOpen && (
                <FilesUploadModal
                    t={t}
                    agent={agent}
                    agentName={name}
                    knowledgeBaseIds={knowledgeBaseIds}
                    onKnowledgeBaseIdsChange={onKnowledgeBaseIdsChange}
                    allKbs={allKbs}
                    onToggleKbLink={toggleKbLink}
                    onCreateKb={createKb}
                    onDocCountChange={onDocCountChange}
                    onKbsChange={refreshKbs}
                    onClose={() => setKnowledgeOpen(false)}
                />
            )}
            {toolChooserOpen && (
                <ToolChooser
                    t={t}
                    ro={ro}
                    open
                    focusAppId={toolChooserAppId}
                    apps={catalogApps}
                    catalogState={catalogState}
                    catalogDegraded={catalogDegraded}
                    onRetryCatalog={refetchCatalog}
                    labels={integrationLabels}
                    toolsConfig={toolsConfig}
                    enabledIntegrations={enabledIntegrations}
                    onCommit={onCommitTools}
                    onClose={() => { setToolChooserOpen(false); setToolChooserAppId(null); }}
                />
            )}
            {scheduleModal && agent?.id && schedulesAllowed && (
                <ScheduleModal
                    t={t}
                    agent={agent}
                    initialSchedule={scheduleModal.mode === 'edit' ? scheduleModal.schedule : null}
                    onClose={() => setScheduleModal(null)}
                    onSaved={async () => {
                        setScheduleModal(null);
                        await refreshAgentSchedules();
                    }}
                />
            )}
            {pendingEmbedEnable && (
                <EnableEmbedConfirmModal
                    t={t}
                    agent={agent}
                    onConfirm={confirmEnableEmbed}
                    onCancel={cancelEnableEmbed}
                />
            )}
            {conflict && (
                <AgentConflictModal
                    t={t}
                    busy={conflictBusy}
                    onLoadLatest={handleConflictLoadLatest}
                    onOverwrite={handleConflictOverwrite}
                    onDismiss={handleConflictDismiss}
                />
            )}
            {scheduleDeleteTarget && (
                <ScheduleDeleteModal
                    t={t}
                    scheduleDeleteTarget={scheduleDeleteTarget}
                    scheduleDeleting={scheduleDeleting}
                    setScheduleDeleteTarget={setScheduleDeleteTarget}
                    setScheduleDeleting={setScheduleDeleting}
                    refreshAgentSchedules={refreshAgentSchedules}
                    mountedRef={mountedRef}
                />
            )}
            <AdvancedDrawer
                open={advancedOpen}
                onClose={() => setAdvancedOpen(false)}
                t={t}
                agent={agent}
                onVersionRestore={handleVersionRestore}
                allowCopy={allowCopy}
                onToggleAllowCopy={toggleAllowCopy}
                disableExternalTools={disableExternalTools}
                onToggleDisableExternalTools={toggleDisableExternalTools}
                embedEnabled={embedEnabled}
                onToggleEmbedEnabled={toggleEmbedEnabled}
                bubbleColor={bubbleColor}
                onBubbleColor={updateBubbleColor}
                bubblePosition={bubblePosition}
                onBubblePosition={updateBubblePosition}
                bubbleIcon={bubbleIcon}
                onBubbleIcon={updateBubbleIcon}
                memoryEnabled={memoryEnabled}
                onToggleMemory={toggleMemory}
                useGeneralMemory={useGeneralMemory}
                onToggleUseGeneralMemory={toggleUseGeneralMemory}
            />
        </div>
    );
}

// The former in-file helper components (InstructionsEditor,
// EnableEmbedConfirmModal, SaveStateIndicator, ActionPill, the schedule
// delete modal) and the extracted handler factories/hooks live in
// ./builderSplit/. Schedule-picker constants and components moved to
// ./pickers/SchedulePickers.jsx.
