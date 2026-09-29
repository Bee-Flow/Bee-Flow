import { FlaskConical, Sparkles, X } from 'lucide-react';
import React, { useState, useRef, useEffect, useEffectEvent, useCallback, useMemo } from 'react';
import AgentConflictModal from './AgentConflictModal';
import { useAgentEditorBootstrap } from './AgentEditorBootstrapContext';
import { API_BASE, authFetch, parseSaveError } from '../../../utils/helpers';
import useUsage from '../../../hooks/useUsage';
import EmptyState from '../../shared/EmptyState';
import UsedByTab from '../../shared/UsedByTab';
import { filterAvailableIntegrations } from '../AgentDesigner/integrationAvailability';
import { INTEGRATION_CATALOG } from '../AgentDesigner/integrations';
import AgentEditorHeader, { AGENT_TAB_IDS, buildAgentTabs, publishedVersionOf } from './builderSplit/AgentEditorHeader';
import AgentHero from './builderSplit/AgentHero';
import BuilderChatPanel from './builderSplit/BuilderChatPanel';
import BuilderConfigPanel from './builderSplit/BuilderConfigPanel';
import { createCategoryActions, createFieldUpdaters, createPublishActions } from './builderSplit/builderSplitActions';
import EnableEmbedConfirmModal from './builderSplit/EnableEmbedConfirmModal';
import { createHandleRefine } from './builderSplit/refineActions';
import RoutineDeleteModal from './builderSplit/RoutineDeleteModal';
import { uploadDocCountOf, uploadKbIdOf } from './builderSplit/uploadKb';
import useAgentConceptFacts from './builderSplit/useAgentConceptFacts';
import useBehaviorToggles from './builderSplit/useBehaviorToggles';
import useChatPanelResize from './builderSplit/useChatPanelResize';
import useKnowledgeBases from './builderSplit/useKnowledgeBases';
import { READ, datatableGrantsOf, datatableRows, knowledgeBaseRows, skillRows } from './canUse/canUseFacts';
import KnowledgeCard from './canUse/KnowledgeCard';
import SkillsCard from './canUse/SkillsCard';
import { CHOOSER_SECTION } from './canUse/toolChooser';
import { automationGrantsOf, automationRows, keepRequiresGrantApps, setAppActAs, setAppConfirm, toolRows } from './canUse/toolGrants';
import ToolChooser from './canUse/ToolChooser';
import ToolsCard from './canUse/ToolsCard';
import useCanUseSources from './canUse/useCanUseSources';
import useToolCatalog from './canUse/useToolCatalog';
import AdvancedDrawer from './pickers/AdvancedDrawer';
import FilesUploadModal from './pickers/FilesUploadModal';
import { RoutineModal } from './pickers/RoutinePickers';
import { adoptedPromptAfterSave, saveAgent } from './state/agentSaveApi';
import TestSetCard from './tests/TestSetCard';
import useAgentTests from './tests/useAgentTests';
import useAgentAutosave from './state/useAgentAutosave';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import { pickAgentAvatar, DEFAULT_AGENT_EMOJI } from '../../../utils/agentAvatar';
import { useCan } from '../../licensing/Gate';

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
    const ro = readOnly || forcedReadOnly;
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
        if (typeof sp === 'string') { try { return JSON.parse(sp); } catch (_) { return []; } }
        return [];
    });
    const [isPublished, setIsPublished] = useState(initialAgent?.is_published === 1 || initialAgent?.is_published === true);
    const [sharedGroups, setSharedGroups] = useState(() => {
        const g = initialAgent?.shared_groups;
        if (Array.isArray(g)) return g;
        if (typeof g === 'string') { try { return JSON.parse(g); } catch (_) { return []; } }
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
    const [tiers, setTiers] = useState({});
    const [selectedTier, setSelectedTier] = useState('fast');
    // Separate tier for the chat/refine panel — does not affect the saved agent model.
    const [chatTier, setChatTier] = useState('fast');

    // Categories + groups (for selectors)
    const [categories, setCategories] = useState([]);
    // "Kon de categorielijst gelezen worden?" — apart van de lijst zelf, zodat
    // een mislukte lezing niet als "deze org heeft geen categorieën" leest.
    const [categoriesState, setCategoriesState] = useState(READ.LOADING);
    const [orgGroups, setOrgGroups] = useState([]);
    const [automations, setAutomations] = useState([]);

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
    // A save came back 409: the agent changed elsewhere. Holds the server's copy
    // so the user can reconcile (load latest vs overwrite mine).
    const [conflict, setConflict] = useState(null); // null | { currentVersion, agent }
    const [conflictBusy, setConflictBusy] = useState(false);

    // De vier tabs van de kop (AgentEditorHeader). De inhoud van elke tab
    // hangt hieronder; de tellers worden verderop berekend, waar de bronnen
    // die ze tellen bekend zijn.
    const [activeTab, setActiveTab] = useState(AGENT_TAB_IDS.ROLE);
    // Inhoud publiceren loopt over een eigen endpoint en heeft dus zijn eigen
    // bezig-vlag, los van de opslagstatus van het concept.
    const [publishing, setPublishing] = useState(false);

    // Loaded once for pickers
    const [allSkills, setAllSkills] = useState(null);          // null = not loaded, [] = loaded but empty
    const [integrationStatus, setIntegrationStatus] = useState(null);
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [appsPickerOpen, setAppsPickerOpen] = useState(false);
    // De tool-kiezer van A2 stap 4: welke ACTIES van een app deze agent mag.
    // `toolChooserAppId` is de app waarop hij opengaat (de ↗ van een rij).
    const [toolChooserOpen, setToolChooserOpen] = useState(false);
    const [toolChooserAppId, setToolChooserAppId] = useState(null);
    const [knowledgeOpen, setKnowledgeOpen] = useState(false);
    const [routinesPickerOpen, setRoutinesPickerOpen] = useState(false);
    const [routineModal, setRoutineModal] = useState(null); // null | { mode: 'create' } | { mode: 'edit', routine }
    const [agentRoutines, setAgentRoutines] = useState([]);
    const [routineDeleteTarget, setRoutineDeleteTarget] = useState(null);
    const [routineDeleting, setRoutineDeleting] = useState(false);
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
            try { unmountAbortRef.current?.abort(); } catch (_) { /* noop */ }
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

    // Unified entitlements check (false while the snapshot loads — the
    // routines panel pops in once it resolves; refreshAgentRoutines re-fires
    // via its dependency when the flag flips true).
    const routinesAllowed = useCan('agent_routines');
    const refreshAgentRoutines = useCallback(async () => {
        if (!routinesAllowed || !agent?.id) return;
        try {
            const res = await authFetch(`${API_BASE}/api/ai-tasks?agentId=${encodeURIComponent(agent.id)}`);
            if (res.ok) {
                const data = await res.json();
                setAgentRoutines(Array.isArray(data?.tasks) ? data.tasks : []);
            }
        } catch (_) { /* non-fatal */ }
    }, [routinesAllowed, agent?.id]);
    useEffect(() => { refreshAgentRoutines(); }, [refreshAgentRoutines]);
    const handleVersionRestore = async () => {
        if (!agent?.id) return;
        try {
            const res = await authFetch(`${API_BASE}/agents/${agent.id}`);
            if (res.ok) {
                const fresh = await res.json();
                setAgent(fresh);
                setName(fresh.name || '');
                setDescription(fresh.description || '');
                setInstructions(fresh.system_prompt || '');
                setAvatar(pickAgentAvatar(fresh) || DEFAULT_AGENT_EMOJI);
                setModel(fresh.model || '');
                if (fresh.model && fresh.model.startsWith('tier:')) setSelectedTier(fresh.model.slice(5));

                // Mirror the restored values into stateRef so the next save
                // sends the restored snapshot, not the pre-restore one. Also
                // clear the dirty flag so a queued autosave doesn't re-PUT
                // stale data on top of the restore.
                stateRef.current.name = fresh.name || '';
                stateRef.current.description = fresh.description || '';
                stateRef.current.systemPrompt = fresh.system_prompt || '';
                stateRef.current.model = fresh.model || '';
                stateRef.current.categoryId = fresh.category_id || null;
                stateRef.current.embedEnabled = fresh.embed_enabled === 1 || fresh.embed_enabled === true;
                stateRef.current.config = { ...(fresh.config || {}) };
                // De grants horen bij de herstelde versie.
                setToolsConfig(fresh.config?.tools ?? null);
                // En de drie lijsten die de kaarten tekenen ook. Ze stonden
                // hier lang niet, en dat viel niet op zolang een restore uit
                // de versiegeschiedenis kwam en je daarna toch wegklikte.
                // Sinds A2 stap 5 is een restore óók de "ongedaan maken" van
                // een verfijning — en die verfijning ZET deze drie. Zonder
                // deze regels blijft een app die de verfijning aanzette na het
                // ongedaan maken gewoon aangevinkt staan, terwijl stateRef hem
                // al niet meer heeft: het scherm liegt dan over wat er is
                // hersteld.
                setEnabledIntegrations(fresh.config?.enabledIntegrations || []);
                setAttachedSkillIds(fresh.config?.attachedSkillIds || []);
                setKnowledgeBaseIds(fresh.config?.knowledge_base_ids || []);
                dirtyRef.current = false;
                setDirty(false);
                // Adopt the restored version so the next autosave uses it as the
                // CAS base (a stale pending save can't clobber the restore).
                setBaseVersion(Number.isInteger(fresh.rev) ? fresh.rev : null);
                hookMarkSaved(fresh, fresh.rev);
                setSavingState('saved'); setSavedAt(new Date());
            }
        } catch (_) { /* ignore */ }
    };

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
    // tiers, automations). When mounted under AgentStudio the data comes from
    // the shared AgentEditorBootstrapProvider — one fetch per session, not
    // one per agent switch. When mounted standalone (the wizard landing
    // path), the context returns empty defaults and we fall back to the local
    // fetch below.
    const bootstrap = useAgentEditorBootstrap();
    const usingProvider = bootstrap.loaded || bootstrap.allSkills !== null;
    useEffect(() => {
        if (!usingProvider) return;
        setAllSkills(bootstrap.allSkills);
        setIntegrationStatus(bootstrap.integrationStatus);
        setCategories(bootstrap.categories);
        setCategoriesState(bootstrap.categoriesState || READ.OK);
        setOrgGroups(bootstrap.orgGroups);
        setTiers(bootstrap.tiers);
        setAutomations(bootstrap.automations);
    }, [usingProvider, bootstrap.allSkills, bootstrap.integrationStatus, bootstrap.categories, bootstrap.categoriesState, bootstrap.orgGroups, bootstrap.tiers, bootstrap.automations]);

    useEffect(() => {
        // Sync the chat-input tier pill with the agent's persisted tier on mount
        // (and on agent switch — useEffect re-runs when initialAgent.id changes
        // because BuilderSplit is keyed by it in AgentStudio).
        if (initialAgent?.model && initialAgent.model.startsWith('tier:')) {
            setSelectedTier(initialAgent.model.slice('tier:'.length));
        }
    }, [initialAgent?.id, initialAgent?.model]);

    // Standalone fallback — only fires when we're NOT under the provider.
    // Uses the same 6-request bootstrap so the legacy wizard landing keeps working.
    useEffect(() => {
        if (usingProvider) return;
        let cancelled = false;
        (async () => {
            try {
                const [skillsRes, statusRes, catsRes, groupsRes, tiersRes, autosRes] = await Promise.all([
                    authFetch(`${API_BASE}/api/skills`),
                    authFetch(`${API_BASE}/ai/user-settings`),
                    authFetch(`${API_BASE}/agents/categories`),
                    authFetch(`${API_BASE}/auth/groups`),
                    authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`),
                    authFetch(`${API_BASE}/automation`).catch(() => ({ ok: false })),
                ]);
                if (cancelled) return;
                setAllSkills(skillsRes.ok ? await skillsRes.json() : []);
                setIntegrationStatus(statusRes.ok ? await statusRes.json() : {});
                if (catsRes.ok) {
                    const list = await catsRes.json();
                    const okList = Array.isArray(list);
                    setCategories(okList ? list : []);
                    setCategoriesState(okList ? READ.OK : READ.ERROR);
                } else {
                    setCategories([]);
                    setCategoriesState(READ.ERROR);
                }
                setOrgGroups(groupsRes.ok ? await groupsRes.json() : []);
                setTiers(tiersRes.ok ? await tiersRes.json() : {});
                if (autosRes.ok) {
                    try {
                        const data = await autosRes.json();
                        setAutomations(Array.isArray(data?.automations) ? data.automations : []);
                    } catch (_) { setAutomations([]); }
                }
            } catch (_) {
                if (!cancelled) {
                    setAllSkills([]);
                    setIntegrationStatus({});
                    setCategoriesState(READ.ERROR);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [usingProvider]);

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

    // De persona die één keer mee moet — zie sentPersonaRef hieronder. Het
    // prompt dat ERBIJ hoorde reist mee zodat `adoptedPromptAfterSave` kan zien
    // of de gebruiker sindsdien getypt heeft.
    const sentPersonaRef = useRef(undefined);
    const sentSystemPromptRef = useRef(undefined);

    // The full canonical snapshot the autosave hook persists on each save.
    const getSnapshot = useCallback(() => {
        // `persona` is EENMALIG: alleen een verfijning zet hem (die rekent hem
        // uit, A1c), en de bevestigde opslag ruimt hem weer op. Ongezet is hij
        // `undefined` en valt hij uit de JSON — en dat is precies wat de server
        // leest als "laat de kolom staan". Zou hij blijven staan, dan stuurt
        // elke latere opslag een persona mee die intussen door een ander
        // scherm veranderd kan zijn, en overschrijft die hem stilletjes.
        sentPersonaRef.current = stateRef.current.persona;
        sentSystemPromptRef.current = stateRef.current.systemPrompt;
        return {
            name: stateRef.current.name,
            description: stateRef.current.description,
            systemPrompt: stateRef.current.systemPrompt,
            model: stateRef.current.model,
            categoryId: stateRef.current.categoryId,
            embedEnabled: stateRef.current.embedEnabled,
            // Top-level avatar so the agents column reflects the picker (the
            // marketplace card reads agent.avatar, not config.avatar).
            avatar: stateRef.current.avatar,
            config: { ...stateRef.current.config },
            persona: stateRef.current.persona,
        };
    }, []);

    const autosave = useAgentAutosave({
        agentId: agent?.id,
        getSnapshot,
        baseVersion,
        enabled: !!agent?.id && !ro,
        saveFn: saveAgent,
        onError: (err) => {
            // Permission 403 → flip into read-only instead of retrying
            // (server rejects every subsequent save anyway).
            if (err?.code === 'agent_not_editable' && mountedRef.current) {
                setForcedReadOnly(true);
            }
        },
        onSaved: (updated, version, meta) => {
            // Refresh the `agent` shell only (id, timestamps, derived fields).
            // Do NOT copy the response into stateRef — by the time it resolves
            // the user may have typed more, and that newer text lives only in
            // stateRef; overwriting would silently lose keystrokes.
            if (updated && mountedRef.current) setAgent(updated);
            if (Number.isInteger(version)) setBaseVersion(version);
            // De eenmalige persona is geland. Alleen opruimen als er sindsdien
            // geen NIEUWE is gezet (identiteit, want elke merge levert een vers
            // object) — anders zou een verfijning tijdens een lopende opslag
            // zijn eigen persona kwijtraken.
            if (stateRef.current.persona !== undefined && stateRef.current.persona === sentPersonaRef.current) {
                stateRef.current.persona = undefined;
            }
            // De persona is de BRON van het prompt: de server rendert hem en
            // negeert het prompt dat we meestuurden. Zonder deze overname houdt
            // de editor zijn eigen tekst vast en schrijft de eerstvolgende
            // opslag (die geen persona draagt) die er weer overheen — waarna de
            // kolom een prompt beschrijft dat de agent niet meer draait.
            const adopted = adoptedPromptAfterSave({
                sentPersona: sentPersonaRef.current,
                sentSystemPrompt: sentSystemPromptRef.current,
                localSystemPrompt: stateRef.current.systemPrompt,
                savedSystemPrompt: updated?.system_prompt,
            });
            if (adopted !== null && mountedRef.current) {
                stateRef.current.systemPrompt = adopted;
                setInstructions(adopted);
            }
            dirtyRef.current = false; setDirty(false);
            setLimitWarning(null);
            const warnings = meta?.warnings || [];
            if (warnings.length && mountedRef.current) {
                setChat(prev => [...prev, { role: 'system', content: `⚠️ ${warnings.length} ${warnings.length === 1 ? 'reference' : 'references'} couldn't be linked and ${warnings.length === 1 ? 'was' : 'were'} skipped.` }]);
            }
        },
        onConflict: ({ currentVersion, agent: serverAgent }) => {
            if (mountedRef.current) setConflict({ currentVersion, agent: serverAgent });
        },
        onLimit: ({ message, resource }) => {
            if (mountedRef.current) setLimitWarning({ message, resource });
        },
    });
    const { queueSave: hookQueueSave, flush: hookFlush, markSaved: hookMarkSaved, status: autosaveStatus, error: autosaveError, savedAt: autosaveSavedAt } = autosave;

    // Mirror the hook's save status into the pill state. The initial 'saved'
    // (for an already-persisted agent) survives until the hook transitions.
    useEffect(() => {
        if (autosaveStatus && autosaveStatus !== 'idle') setSavingState(autosaveStatus);
        setSaveErrorMsg(autosaveError || '');
    }, [autosaveStatus, autosaveError]);
    useEffect(() => { if (autosaveSavedAt) setSavedAt(autosaveSavedAt); }, [autosaveSavedAt]);

    // Public save helpers used by the ~20 edit handlers below. queueSave also
    // marks the local dirty flag for the parent's unsaved-changes guard.
    const queueSave = useCallback((immediate = false) => {
        // Read-only: belt-and-braces so any edit handler that slipped through
        // the disabled UI can never mark dirty or fire a save.
        if (roRef.current) return;
        dirtyRef.current = true;
        setDirty(true);
        hookQueueSave(immediate);
    }, [hookQueueSave]);
    const flush = useCallback(() => hookFlush(), [hookFlush]);

    // ── Inhoud publiceren (POST /agents/:id/publish-version) ──────
    // Het TWEEDE publiceer-werkwoord van een agent: welke config en welk
    // systeemprompt de RUNTIME serveert. De capsule ernaast in de kop regelt
    // het PUBLIEK (PATCH /:id/publish). Ze staan naast elkaar omdat ze
    // allebei "publiceren" heten; ze mogen nooit dezelfde knop worden.
    //
    // Eerst flushen: een concept dat nog niet op de server staat kan niet
    // gepubliceerd worden, en de server kopieert wat er ligt — niet wat er in
    // dit tabblad getypt is. Bij een fout blijft de gepubliceerde versie staan
    // die er stond; er wordt niets optimistisch opgehoogd.
    const publishVersion = useCallback(async () => {
        if (roRef.current || !agentIdRef.current) return;
        setPublishing(true);
        try {
            if (dirtyRef.current) await flush();
            const res = await authFetch(`${API_BASE}/agents/${agentIdRef.current}/publish-version`, { method: 'POST' });
            if (!res.ok) {
                const info = await parseSaveError(res);
                if (mountedRef.current) { setSavingState('error'); setSaveErrorMsg(info.message); }
                return;
            }
            const body = await res.json().catch(() => ({}));
            if (!mountedRef.current) return;
            setSaveErrorMsg('');
            const version = Number(body?.publishedVersion);
            // Alleen ophogen als de server een versie NOEMT. Een antwoord dat
            // we niet kunnen lezen laat de kop staan waar hij stond; "v?" of
            // een opgehoogde gok zou een publicatie claimen die niemand zag.
            if (Number.isFinite(version) && version > 0) {
                setAgent(prev => (prev ? { ...prev, published_version: version } : prev));
            }
        } catch (err) {
            if (mountedRef.current) {
                setSavingState('error');
                setSaveErrorMsg(String(err?.message || err || 'Publish failed').slice(0, 500));
            }
        } finally {
            if (mountedRef.current) setPublishing(false);
        }
    }, [flush]);

    // ── Conflict (409) reconcile ──────────────────────────────────
    // Load latest: re-fetch the server copy and rehydrate (discards local
    // unsaved edits — the modal warns about this). Reuses handleVersionRestore.
    const handleConflictLoadLatest = async () => {
        if (conflictBusy) return;
        setConflictBusy(true);
        try { await handleVersionRestore(); } finally {
            if (mountedRef.current) { setConflict(null); setConflictBusy(false); }
        }
    };
    // Overwrite: re-send the local snapshot with the server's current version as
    // the CAS base. If it conflicts again, re-open with the newer version.
    const handleConflictOverwrite = async () => {
        if (conflictBusy || !agentIdRef.current || !conflict) return;
        setConflictBusy(true);
        try {
            const res = await saveAgent(agentIdRef.current, getSnapshot(), conflict.currentVersion);
            if (!mountedRef.current) return;
            if (res.ok) {
                if (res.updated) setAgent(res.updated);
                if (Number.isInteger(res.version)) setBaseVersion(res.version);
                hookMarkSaved(res.updated, res.version);
                dirtyRef.current = false; setDirty(false);
                setConflict(null);
            } else if (res.conflict) {
                setConflict({ currentVersion: res.currentVersion, agent: res.agent });
            } else if (res.limit) {
                setLimitWarning({ message: res.message, resource: res.resource });
                setConflict(null);
            }
        } catch (err) {
            if (mountedRef.current) {
                setSavingState('error');
                setSaveErrorMsg(String(err?.message || err || 'Save failed').slice(0, 500));
                setConflict(null);
            }
        } finally {
            if (mountedRef.current) setConflictBusy(false);
        }
    };
    const handleConflictDismiss = () => { if (!conflictBusy) setConflict(null); };

    useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

    // Explicit first-save for drafts. Until this runs, the agent only exists
    // in memory — POST creates it on the server, then the editor switches to
    // its normal auto-save behaviour.
    const saveDraft = useCallback(async () => {
        if (agentIdRef.current) return;
        setSavingState('saving');
        const sentPersona = stateRef.current.persona;
        const sentSystemPrompt = stateRef.current.systemPrompt;
        try {
            const res = await authFetch(`${API_BASE}/agents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: stateRef.current.name,
                    description: stateRef.current.description,
                    systemPrompt: stateRef.current.systemPrompt,
                    model: stateRef.current.model,
                    categoryId: stateRef.current.categoryId,
                    embedEnabled: stateRef.current.embedEnabled,
                    avatar: stateRef.current.avatar,
                    config: { ...stateRef.current.config },
                    // Zelfde eenmalige persona als getSnapshot: een concept dat
                    // vóór zijn eerste opslag verfijnd is, hoort zijn rol mee
                    // te krijgen. Ongezet valt hij uit de JSON.
                    persona: stateRef.current.persona,
                }),
            });
            if (!res.ok) {
                const info = await parseSaveError(res);
                if (info.isLimit) {
                    setLimitWarning({ message: info.message, resource: info.resource });
                    setSavingState('error');
                    setSaveErrorMsg(info.message);
                    return;
                }
                throw new Error(info.message);
            }
            const created = await res.json();
            // Zelfde overname als in onSaved: het antwoord draagt het prompt
            // dat de server uit de persona rendeerde, niet het onze.
            const adopted = adoptedPromptAfterSave({
                sentPersona: sentPersona,
                sentSystemPrompt,
                localSystemPrompt: stateRef.current.systemPrompt,
                savedSystemPrompt: created?.system_prompt,
            });
            if (adopted !== null) {
                stateRef.current.systemPrompt = adopted;
                setInstructions(adopted);
            }
            stateRef.current.persona = undefined; // geland
            setAgent(created);
            agentIdRef.current = created.id;
            // Seed the concurrency token so post-create autosaves use CAS.
            setBaseVersion(Number.isInteger(created.rev) ? created.rev : 1);
            hookMarkSaved(created, created.rev);
            dirtyRef.current = false;
            setDirty(false);
            setSavingState('saved');
            setSavedAt(new Date());
            setSaveErrorMsg('');
            setLimitWarning(null);
            if (onPublished) onPublished(created);
        } catch (err) {
            console.error('Save draft failed:', err);
            setSavingState('error');
            setSaveErrorMsg(String(err?.message || err || 'Unknown error').slice(0, 500));
        }
    }, [onPublished, hookMarkSaved]);

    // Best-effort flush of any pending auto-save when the tab is being closed.
    // We deliberately don't preventDefault / set returnValue here — the unsaved
    // changes UX is handled in-app via the parent's confirmation modal, not
    // the browser's native "Leave site?" dialog.
    useEffect(() => {
        const onBeforeUnload = () => {
            if (roRef.current) return; // read-only sessions never save
            if (agentIdRef.current && dirtyRef.current) {
                // Best-effort last save on tab close. Deliberately WITHOUT a
                // baseVersion so it lands unguarded (a 409 has no UI to reconcile
                // against during unload).
                const snapshot = {
                    name: stateRef.current.name,
                    description: stateRef.current.description,
                    systemPrompt: stateRef.current.systemPrompt,
                    config: stateRef.current.config,
                };
                try {
                    navigator.sendBeacon(
                        `${API_BASE}/agents/${agentIdRef.current}`,
                        new Blob([JSON.stringify(snapshot)], { type: 'application/json' })
                    );
                } catch (_) { /* ignore */ }
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

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

    // ── De tab "Kan gebruiken" (A2 stap 2) ────────────────────────
    // De grants staan in de OPGESLAGEN config: `config.tools.datatables` is
    // wat de runtime leest, en de editor schrijft er (nog) niet aan. `agent`
    // wordt na elke opslag ververst, dus dit blijft meelopen.
    const datatableGrantCount = datatableGrantsOf(toolsConfig).grants.length;
    const automationGrantCount = automationGrantsOf(toolsConfig).length;
    const canUseActive = activeTab === AGENT_TAB_IDS.CAN_USE;
    const { tables, tablesState, refetchTables, usage: skillUsage, usageState: skillUsageState } =
        useCanUseSources({
            enabled: canUseActive,
            toolsConfig,
            attachedSkillIds,
            // De OPGESLAGEN lijst hoort erbij: de gebruikstelling van de server
            // kent alleen die, dus hij moet opnieuw gelezen worden zodra de
            // opslag landt. Zie useCanUseSources.
            savedSkillIds: agent?.config?.attachedSkillIds || [],
        });
    // De statische naamkaart van de frontend, ÉÉN keer. Inline opgebouwd is
    // hij elke render een nieuw object, en dan rekent elke consument opnieuw —
    // wat de tool-kiezer middenin het vinken opnieuw liet beginnen.
    const integrationLabels = useMemo(
        () => Object.fromEntries(INTEGRATION_CATALOG.map(a => [a.id, a.label])),
        [],
    );

    // De app-actiecatalogus en de leen-grants (A2 stap 3). De catalogus komt
    // van `GET /agents/tool-catalog` — de ONGEGATE tweede bron, want
    // /api/automation/catalog hangt achter de automations-module en
    // agent-tool-grants hebben daar niets mee te maken. Zie useToolCatalog.
    const {
        apps: catalogApps, catalogState, catalogDegraded, providersKnown, lendingEnabled,
        refetchCatalog, lentApps, lentState, refetchLent, runtimeCurated,
    } = useToolCatalog({ enabled: canUseActive, agentId: agent?.id || null });

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
    // hangt op /agents (server/index.js). Vandaar een eigen fetcher; zonder
    // die zou elke lezing een 404 zijn en de tab permanent "niet gelezen".
    const usageFetcher = useCallback(async (_kind, id) => {
        const res = await authFetch(`${API_BASE}/agents/${encodeURIComponent(String(id))}/usage`);
        let body = null;
        try { body = await res.json(); } catch (_) { /* leeg of geen JSON */ }
        if (!res.ok) {
            const err = new Error(body?.error || `Request failed (${res.status})`);
            err.status = res.status;
            err.code = body?.code || null;
            throw err;
        }
        return body;
    }, []);
    const { usage: agentUsage, error: usageError, refetch: refetchUsage } = useUsage('agent', agent?.id || null, { fetcher: usageFetcher });
    // Een mislukte lezing laat useUsage op [] landen MET een error ernaast.
    // Die [] mag nooit als "niemand gebruikt dit" op het scherm komen, dus de
    // teller is dan onbekend — niet 0.
    const usedByCount = usageError ? undefined : (Array.isArray(agentUsage) ? agentUsage.length : undefined);

    const tabs = buildAgentTabs(t, { canUseCount, usedByCount });

    // ── De rijen van "Kan gebruiken" ──────────────────────────────
    // Puur afgeleid (canUse/canUseFacts.js): de KOPPELING komt uit de config
    // en is dus altijd bekend, de NAMEN komen uit lezingen die kunnen
    // ontbreken. Een koppeling zonder naam blijft staan — wegfilteren zou de
    // kaart laten beweren dat de agent die kennis niet heeft.
    const knowledgeRows = knowledgeBaseRows({ ids: knowledgeBaseIds, kbs: allKbs, state: kbsState });
    const { rows: tableGrantRows, truncated: tablesTruncated } = datatableRows({ toolsConfig, tables, state: tablesState });
    const attachedSkillRows = skillRows({
        ids: attachedSkillIds,
        skills: allSkills,
        // `allSkills` is `null` tot de bootstrap klaar is — dat is LADEN, niet
        // "deze organisatie heeft geen skills".
        state: allSkills === null ? READ.LOADING : READ.OK,
        usage: skillUsage,
        usageState: skillUsageState,
        // De server telt de OPGESLAGEN config; een zojuist aangevinkte skill
        // zit daar nog niet in, dus dan gaat de agent zelf er ook niet af.
        savedSkillIds: agent?.config?.attachedSkillIds || [],
        agentSaved: !!agent?.id,
    });

    // ── De Tools-kaart (A2 stap 3) ────────────────────────────────
    // De rijen komen uit `enabledIntegrations` (de app-niveau aan/uit-lijst)
    // plus elke app die in `config.tools` een entry heeft. De catalogus vult
    // de tellingen, de werkwoorden en het effect aan — en als hij ontbreekt
    // blijven de rijen staan met de SMALLE lezing: onbekend effect telt als
    // "het verstuurt". Zie canUse/toolGrants.js.
    const appToolRows = toolRows({
        toolsConfig,
        enabledIntegrations,
        apps: catalogApps,
        catalogState,
        providersKnown,
        // De NAAM van een app hoeft geen server te beantwoorden: de statische
        // catalogus van de frontend kent hem. Zonder deze val de rij bij een
        // mislukte lezing terug op het kale id.
        labels: integrationLabels,
        lentApps,
        lendingEnabled,
        // De leen-meldingen gaan over de RUNTIME, en die leest de gepubliceerde
        // config — niet de draft die hier in handen is. Het antwoord komt dus
        // van de server; `null` betekent "niet na te gaan" en dan zegt de kaart
        // er niets over.
        runtimeCurated,
    });
    const grantedAutomationRows = automationRows({
        toolsConfig,
        automations,
        // `automations` is `[]` zolang de bootstrap loopt én wanneer de
        // organisatie de module niet heeft. Dat verschil kunnen we hier niet
        // zien, dus de grant blijft staan en de naam ontbreekt met uitleg —
        // dezelfde degradatie als bij de tabel-grants.
        state: Array.isArray(automations) && automations.length > 0 ? READ.OK : READ.ERROR,
    });

    /**
     * Eén grant-mutatie: pas de map aan, teken hem meteen, en sla hem op.
     *
     * `patchConfig` schrijft in `stateRef` (wat de autosave verstuurt); de
     * lokale state is er alleen om de kaart niet te laten wachten op de
     * server. Beide krijgen dezelfde map, uit `toolGrants.js` — dat is de
     * enige plek waar een grants-map gebouwd wordt.
     */
    const writeTools = useCallback((next) => {
        // De eerste entry zet de agent in het bevestigingsregime, en verandert
        // daarmee de betekenis van zwijgen voor de apps die de kiezer nooit kon
        // tonen. Dat mag geen BIJVANGST zijn van een klik op een andere rij:
        // leg vast wat er stond. Zie `keepRequiresGrantApps`.
        const before = stateRef.current.config?.tools ?? null;
        const kept = keepRequiresGrantApps(before, next, {
            apps: catalogApps,
            enabledIntegrations: stateRef.current.config?.enabledIntegrations ?? null,
        });
        setToolsConfig(kept);
        patchConfig({ tools: kept });
    }, [patchConfig, catalogApps]);

    /**
     * Moet deze app expliciet genoemd worden voordat een gecureerde agent er
     * iets van krijgt? (`requiresGrant` uit de catalogus.)
     *
     * De twee mutaties hieronder ZETTEN een entry bij, en een entry bijzetten
     * mag de acties niet veranderen — bij zo'n app is "geen actielijst" namelijk
     * niets in plaats van alles. Zonder dit antwoord zou "Confirm first"
     * aanzetten een agent stilzwijgend een volledige browser geven.
     */
    const requiresGrantOf = useCallback((appId) => {
        const app = Array.isArray(catalogApps) ? catalogApps.find(a => a && a.id === appId) : null;
        return !!(app && app.requiresGrant);
    }, [catalogApps]);

    const onChangeConfirm = useCallback((appId, confirm) => {
        writeTools(setAppConfirm(stateRef.current.config?.tools ?? null, appId, confirm,
            { requiresGrant: requiresGrantOf(appId) }));
    }, [writeTools, requiresGrantOf]);
    const onChangeActAs = useCallback((appId, actAs) => {
        writeTools(setAppActAs(stateRef.current.config?.tools ?? null, appId, actAs,
            { requiresGrant: requiresGrantOf(appId) }));
    }, [writeTools, requiresGrantOf]);

    /**
     * Wat de tool-kiezer oplevert: ÉÉN opslag voor allebei de poorten.
     *
     * De kiezer bedient de app-niveau lijst (`enabledIntegrations`) én de
     * actie-niveau map (`config.tools`), en die horen in dezelfde patch: twee
     * losse patches zouden een moment opleveren waarin de app aanstaat zonder
     * dat er acties bij staan (of andersom), en dát is het moment waarop een
     * autosave kan landen.
     */
    const onCommitTools = useCallback(({ tools, enabledIntegrations: nextEnabled, enabledChanged }) => {
        setToolsConfig(tools);
        if (enabledChanged && Array.isArray(nextEnabled)) {
            setEnabledIntegrations(nextEnabled);
            patchConfig({ tools, enabledIntegrations: nextEnabled });
            return;
        }
        patchConfig({ tools });
    }, [patchConfig]);

    /**
     * "+ Koppelen" op een kaart. DE naad naar de tool-kiezer van A2 stap 4.
     *
     * Zolang die kiezer er niet is opent dit wat er vandaag bestaat, in plaats
     * van een knop die niets doet: de kennisbankenlijst en de skill-popover.
     * Beide zitten op de Rol-tab, dus daar gaan we heen — een popover die
     * "open" staat op een tab die hem niet tekent is precies het stille
     * niet-doen dat we vermijden. Stap 4 vervangt dit lichaam, niet de
     * aanroepen op de kaarten.
     */
    const openChooser = useCallback((request) => {
        if (!request) return;
        if (request.section === CHOOSER_SECTION.KNOWLEDGE_BASES) { setKnowledgeOpen(true); return; }
        if (request.section === CHOOSER_SECTION.SKILLS) { setActiveTab(AGENT_TAB_IDS.ROLE); setSkillPickerOpen(true); return; }
        // De ↗ op een tool-rij opent de kiezer op DIE app; de "+ Koppelen" van
        // de kaart opent hem zonder focus. Hij hoort bij de kaart, dus we
        // blijven op "Kan gebruiken" — de catalogus die hij nodig heeft wordt
        // ook alleen op die tab gelezen (useToolCatalog).
        if (request.section === CHOOSER_SECTION.APPS) {
            setActiveTab(AGENT_TAB_IDS.CAN_USE);
            setToolChooserAppId(request.appId || null);
            setToolChooserOpen(true);
        }
    }, []);

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
        availableIntegrations, tiers, queueSave, routinesAllowed, agent, refreshAgentRoutines,
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
            try { await flush(); } catch (_) { /* best effort — de restore is de waarheid */ }
            const res = await authFetch(`${API_BASE}/versions/${agentIdRef.current}/${versionId}/restore`, { method: 'POST' });
            if (!res.ok) { finish('failed'); return; }
            await handleVersionRestore();
            finish('undone');
        } catch (_) {
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
            {limitWarning && (
                <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[min(560px,92vw)]">
                    <div className="rounded-xl border border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 shadow-lg px-4 py-3 flex items-start gap-3">
                        <Sparkles className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                                {t('agent_wizard.limit_reached_title', 'Plan limit reached')}
                            </p>
                            <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{limitWarning.message}</p>
                            <a
                                href="/app/settings/organisation/license"
                                className="inline-flex items-center gap-1 mt-2 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-amber-500 text-white hover:bg-amber-600"
                            >
                                {t('agent_wizard.view_plans', 'View plans & upgrade')}
                            </a>
                        </div>
                        <button onClick={() => setLimitWarning(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0" aria-label="Dismiss">
                            <X size={16} />
                        </button>
                    </div>
                </div>
            )}

            {/* De gedeelde Studio-kop. Bewust NIET inert bij alleen-lezen: de
                terugpijl en de tabs moeten blijven werken voor iemand die de
                agent alleen mag bekijken (BFSF-271). */}
            <AgentEditorHeader
                t={t}
                ro={ro}
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
                            routinesAllowed={routinesAllowed} agentRoutines={agentRoutines}
                            routinesPickerOpen={routinesPickerOpen} setRoutinesPickerOpen={setRoutinesPickerOpen}
                            advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen} memoryEnabled={memoryEnabled} embedEnabled={embedEnabled}
                            refreshAgentRoutines={refreshAgentRoutines} setRoutineModal={setRoutineModal} setRoutineDeleteTarget={setRoutineDeleteTarget}
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
                        <div className="max-w-4xl mx-auto px-10 py-6">
                            <KnowledgeCard
                                t={t}
                                ro={ro}
                                rel={rel}
                                kbRows={knowledgeRows}
                                kbState={kbsState}
                                onRetryKbs={refreshKbs}
                                tableRows={tableGrantRows}
                                tableState={tablesState}
                                tableTruncated={tablesTruncated}
                                onRetryTables={refetchTables}
                                includeSourceReferences={includeSourceReferences}
                                onIncludeSourceReferencesChange={onIncludeSourceReferencesChange}
                                onOpenChooser={openChooser}
                                onNavigate={onNavigate}
                                tipKbId={knowledgeBaseIds[0] || null}
                            />
                            <SkillsCard
                                t={t}
                                ro={ro}
                                rows={attachedSkillRows}
                                state={allSkills === null ? READ.LOADING : READ.OK}
                                usageState={skillUsageState}
                                onOpenChooser={openChooser}
                            />
                            <ToolsCard
                                t={t}
                                ro={ro}
                                rows={appToolRows}
                                apps={catalogApps}
                                catalogState={catalogState}
                                catalogDegraded={catalogDegraded}
                                onRetryCatalog={refetchCatalog}
                                lentState={lentState}
                                onRetryLent={refetchLent}
                                automationRows={grantedAutomationRows}
                                automationsState={grantedAutomationRows.some(r => !r.readable) ? READ.ERROR : READ.OK}
                                onChangeConfirm={onChangeConfirm}
                                onChangeActAs={onChangeActAs}
                                onOpenChooser={openChooser}
                            />
                        </div>
                    )}

                    {activeTab === AGENT_TAB_IDS.TEST && (
                        <div className="max-w-4xl mx-auto px-10 py-10">
                            {agent?.id ? (
                                <TestSetCard
                                    t={t}
                                    ro={ro}
                                    rel={rel}
                                    tests={testSet.tests}
                                    testsState={testSet.testsState}
                                    onRetryTests={testSet.refetch}
                                    readRefusal={testSet.readRefusal}
                                    lastRun={testSet.lastRun}
                                    lastRunUnknown={testSet.lastRunUnknown}
                                    runs={testSet.runs}
                                    runsState={testSet.runsState}
                                    runsUnknown={testSet.runsUnknown}
                                    runsKeep={testSet.runsKeep}
                                    onOpenDetail={testSet.loadRuns}
                                    progress={testSet.progress}
                                    running={testSet.running}
                                    refusal={testSet.refusal}
                                    onRetryRun={testSet.runTests}
                                    onRun={testSet.runTests}
                                />
                            ) : (
                                // Een agent zonder id is nog nergens opgeslagen,
                                // dus er is niets om vragen aan te hangen.
                                <EmptyState
                                    icon={<FlaskConical size={28} aria-hidden="true" />}
                                    title={t('agent_studio.test.soon_title', 'Test questions land here')}
                                    description={t('agent_studio.test.soon_body', 'Ask this agent a set of questions and see what it answers before anyone else does.')}
                                />
                            )}
                        </div>
                    )}

                    {activeTab === AGENT_TAB_IDS.USED_BY && (
                        <div className="max-w-4xl mx-auto px-10 py-6">
                            {usageError ? (
                                // "Niet gelezen" mag nooit als "niemand gebruikt
                                // dit" op het scherm komen. UsedByTab zet bij een
                                // fout de waarschuwing BOVEN zijn lege-lijst-zin
                                // ("Nothing uses this yet."), en die zin is precies
                                // de bewering die een mislukte lezing niet mag doen
                                // — dus tekenen we hem hier niet, we vragen het
                                // opnieuw.
                                <div role="status" data-testid="agent-usage-error" className="text-sm text-[var(--text-secondary)] flex flex-col items-start gap-2">
                                    <span style={{ color: 'var(--warning)' }}>
                                        {t('agent_studio.used_by.unreadable', 'Could not load who uses this agent, so nothing is claimed here.')}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={refetchUsage}
                                        className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border-default)] hover:bg-[var(--bg-secondary)] transition"
                                    >
                                        {t('agent_studio.retry', 'Retry')}
                                    </button>
                                </div>
                            ) : (
                                <UsedByTab
                                    rows={agentUsage}
                                    currentUserId={user?.id || null}
                                    emptyText={t('agent_studio.used_by.empty', 'Nothing uses this agent yet.')}
                                />
                            )}
                        </div>
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
            {routineModal && agent?.id && routinesAllowed && (
                <RoutineModal
                    t={t}
                    agent={agent}
                    initialRoutine={routineModal.mode === 'edit' ? routineModal.routine : null}
                    onClose={() => setRoutineModal(null)}
                    onSaved={async () => {
                        setRoutineModal(null);
                        await refreshAgentRoutines();
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
            {routineDeleteTarget && (
                <RoutineDeleteModal
                    t={t}
                    routineDeleteTarget={routineDeleteTarget}
                    routineDeleting={routineDeleting}
                    setRoutineDeleteTarget={setRoutineDeleteTarget}
                    setRoutineDeleting={setRoutineDeleting}
                    refreshAgentRoutines={refreshAgentRoutines}
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
// EnableEmbedConfirmModal, SaveStateIndicator, ActionPill, the routine
// delete modal) and the extracted handler factories/hooks live in
// ./builderSplit/. Routine-picker constants and components moved to
// ./pickers/RoutinePickers.jsx.
