import { useEffect, useRef, useEffectEvent } from 'react';
import { parseSaveError } from '@/utils/helpers';
import { RefusedError, errorBody } from '@/api/mutate';
import { apiFetch, apiRequest } from '@/api/typedRequest';
import { logger } from '@/utils/logger';
import { filterVisibleModels, fetchAllowedModelsByAgentType } from '@/api/modelMeta';
import { toast } from '@/components/shared/Toast';
import useConfirm from '@/components/shared/useConfirm';
import { messageOf } from '@/utils/caughtError';
import type { AgentSaveBody, ApiOptions, ApiState, DesignerAgent, DesignerConfig, DesignerMessage } from './useAgentApi.types';
import { storedConfig, storedFlag } from '../storedFlag';

/** GET /agents/:id answers with the published copy of a published agent unless asked for the editor's draft. */
const DRAFT = { draft: '1' } as const;

/**
 * All API operations for the AgentDesigner: fetch, save, delete, duplicate, publish.
 * Accepts the state object from useAgentState.
 */
export default function useAgentApi(state: ApiState, { systemMode, initialAgentId, orgId }: ApiOptions) {
    const orgQuery = orgId ? { orgId } : undefined;
    const {
        setAgents, setLoading, setComponents, setAvailableModels,
        setAvailableCollections, setModelTiers, setIntegrationStatus,
        setOrganizations, setOrgGroups, model, setModel,
        selectedAgent, setSelectedAgent, setIsCreating,
        setName, setDescription, setSystemPrompt, setSelectedTools,
        setToolParams, setIsPublished, setSharedGroups, setStarterPrompts,
        setAvatar, allowCopy, setAllowCopy, setEmbedEnabled, setWorkspaceEnabled,
        setEnableGuardrails, setLlamaGuardEnabled, setWebSearchGuardEnabled,
        strictKnowledge, setStrictKnowledge, setIncludeSourceReferences, setKnowledgeBaseIds,
        setEnabledIntegrations, setRegexGuardrailsEnabled, setSelectedCollections,
        setRegexScope, setGuardrailAction, setMessages, setShowChat,
        setActiveSection, name, description, systemPrompt, selectedTools,
        toolParams, starterPrompts, avatar, workspaceEnabled, embedEnabled,
        enableGuardrails, llamaGuardEnabled, webSearchGuardEnabled, disableExternalTools,
        includeSourceReferences, knowledgeBaseIds, enabledIntegrations,
        regexGuardrailsEnabled, selectedCollections, regexScope, guardrailAction,
        isPublished, sharedGroups, saving, setSaving, showPublishMenu, setShowPublishMenu,
        setPublishError,
        categoryId, setCategoryId, setAgentCategories,
        setDisableExternalTools,
    } = state;
    const initialSelectionDoneRef = useRef(false);
    // The config of the agent a new agent starts from (a duplicate's source, or
    // nothing), so a save keeps the keys the designer does not edit.
    const baseConfigRef = useRef<Record<string, unknown>>({});
    const { confirm, confirmDialog } = useConfirm();
    const fetchAgents = async () => {
        try {
            const res = systemMode
                ? await apiFetch('GET /agents/system')
                : await apiFetch('GET /agents/all', { query: orgQuery });
            const data = await res.json();
            // A refusal (a 404 for an organisation that is gone, a 403) is an error body, not a list.
            if (!res.ok || !Array.isArray(data)) { setAgents([]); return; }
            setAgents(data);
            // Auto-select agent if initialAgentId is provided (once)
            if (initialAgentId && !initialSelectionDoneRef.current) {
                initialSelectionDoneRef.current = true;
                const target = data.find((a: DesignerAgent) => a.id === initialAgentId);
                if (target) {
                    // Defer to avoid state conflicts during initial mount
                    setTimeout(() => selectAgent(target), 0);
                }
            }
        } catch (err) {
            console.error('Failed to fetch agents:', err);
        } finally {
            setLoading(false);
        }
    };

    const fetchComponents = async () => {
        try {
            const res = await apiFetch('GET /agents/meta/components');
            const data = await res.json();
            if (Array.isArray(data)) {
                setComponents(data);
            } else {
                console.error('Components response not an array:', data);
            }
        } catch (err) {
            console.error('Failed to fetch components:', err);
        }
    };

    const fetchModels = async () => {
        try {
            const res = await apiFetch('GET /agents/meta/models');
            const data = await res.json();
            if (data.models) {
                const allowedConfig = await fetchAllowedModelsByAgentType();
                const visibleModels = filterVisibleModels(data.models, 'chat', allowedConfig);
                setAvailableModels(visibleModels);
                if (!model && data.currentModel) {
                    setModel(data.currentModel);
                }
            }
        } catch (err) {
            console.error('Failed to fetch models:', err);
        }
    };

    const fetchCollections = async () => {
        try {
            const res = await apiFetch('GET /ai/config');
            const data = await res.json();
            if (data.regexGuardrails?.collections) {
                setAvailableCollections(data.regexGuardrails.collections);
            }
        } catch (err) {
            console.error('Failed to fetch collections:', err);
        }
    };

    const fetchModelTiers = async () => {
        try {
            const res = await apiRequest('GET /ai/config/chat-models').catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) setModelTiers(await res.json());
        } catch (e) { console.error('Failed to load model tiers:', e); }
    };

    const fetchIntegrationStatus = async () => {
        try {
            const res = await apiRequest('GET /ai/user-settings').catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) setIntegrationStatus(await res.json());
        } catch (e) { console.error('Failed to load integration status:', e); }
    };

    // Initial data load, the agent categories last
    const runFetchAgentsEffect = useEffectEvent(() => {
        fetchAgents();
        fetchComponents();
        fetchModels();
        fetchCollections();
        fetchModelTiers();
        fetchIntegrationStatus();
        (async () => {
            try {
                const res = await apiRequest('GET /agents/categories', { query: systemMode ? undefined : orgQuery }).catch((err: unknown) => {
                    if (err instanceof RefusedError) return null;
                    throw err;
                });
                if (res) {
                    const cats = await res.json();
                    setAgentCategories(Array.isArray(cats) ? cats : []);
                }
            } catch (e) { console.warn('Failed to load agent categories', e); }
        })();
    });
    useEffect(() => { return runFetchAgentsEffect(); }, []);

    // Load org data for publish targets
    useEffect(() => {
        const loadOrgData = async () => {
            try {
                const [orgsRes, groupsRes] = await Promise.all([
                    apiFetch('GET /auth/organizations'),
                    apiFetch('GET /auth/groups')
                ]);
                if (orgsRes.ok) setOrganizations(await orgsRes.json());
                if (groupsRes.ok) setOrgGroups(await groupsRes.json());
            } catch (err) {
                console.error('Failed to load org data:', err);
            }
        };
        loadOrgData();
    }, [setOrgGroups, setOrganizations]);

    /**
     * The settings kept in the row's on/off columns and its `config`. The
     * config is also kept whole: a new agent (a duplicate) is saved over it,
     * so the keys the designer does not edit travel along.
     */
    const applyStoredSettings = (stored: { config?: unknown; embed_enabled?: unknown; workspace_enabled?: unknown }) => {
        const config = storedConfig(stored.config) as DesignerConfig;
        baseConfigRef.current = config;
        setAllowCopy(config.allowCopy !== false);
        setEmbedEnabled(storedFlag(stored.embed_enabled, false));
        setWorkspaceEnabled(storedFlag(stored.workspace_enabled, false));
        setEnableGuardrails(config.enableGuardrails === true);
        setLlamaGuardEnabled(config.llamaGuardEnabled === true);
        setWebSearchGuardEnabled(config.webSearchGuardEnabled === true);
        setStrictKnowledge(config.strictKnowledge === true);
        setDisableExternalTools(config.disableExternalTools === true);
        setIncludeSourceReferences(config.includeSourceReferences === true);
        setEnabledIntegrations(config.enabledIntegrations || null);
        setKnowledgeBaseIds(config.knowledge_base_ids || []);
        const rgConfig = config.regexGuardrails || {};
        setRegexGuardrailsEnabled(rgConfig.enabled === true);
        setSelectedCollections(rgConfig.collectionIds || []);
        setRegexScope(rgConfig.scope || { userInput: true, agentOutput: true, toolInput: false, toolOutput: false });
        setGuardrailAction(rgConfig.action || 'delete');
    };

    const selectAgent = async (agent: DesignerAgent) => {
        setSelectedAgent(agent);
        setIsCreating(false);
        if (agent) {
            try {
                // The draft: without `?draft=1` a published agent answers with its published copy.
                const freshRes = await apiFetch('GET /agents/{id}', { params: { id: agent.id }, query: DRAFT });
                const freshAgent = await freshRes.json();
                logger.debug('[AgentDesigner] Loaded agent with tool_params:', freshAgent.tool_params);

                setName(freshAgent.name || '');
                setDescription(freshAgent.description || '');
                setSystemPrompt(freshAgent.system_prompt || '');
                setSelectedTools(freshAgent.tools || []);
                setToolParams(freshAgent.tool_params || {});
                setModel(freshAgent.model || '');
                setIsPublished(storedFlag(freshAgent.is_published, false));
                setSharedGroups(Array.isArray(freshAgent.shared_groups) ? freshAgent.shared_groups : (() => { try { return JSON.parse(freshAgent.shared_groups || '[]'); } catch (_) { return []; } })());
                setStarterPrompts(typeof freshAgent.starter_prompts === 'string' ? JSON.parse(freshAgent.starter_prompts || '[]') : (freshAgent.starter_prompts || []));
                setAvatar(freshAgent.avatar || '🤖');
                setCategoryId(freshAgent.category_id || null);

                applyStoredSettings(freshAgent);
            } catch (err) {
                console.error('Failed to fetch agent details:', err);
            }
        }
        setShowChat(false);

        // Fetch conversation history
        try {
            const res = await apiFetch('GET /agents/{id}/history', { params: { id: agent.id } });
            const history = await res.json();
            setMessages(history.filter((m: DesignerMessage) => m.role === 'user' || m.role === 'assistant'));
        } catch (err) {
            setMessages([]);
        }
    };

    const createNewAgent = () => {
        setSelectedAgent(null);
        setIsCreating(true);
        setName('');
        setDescription('');
        setSystemPrompt('You are a helpful AI assistant. Use the available tools when appropriate to help accomplish tasks.');
        setSelectedTools([]);
        setModel('');
        setIsPublished(false);
        setSharedGroups([]);
        setStarterPrompts([]);
        setMessages([]);
        setShowChat(false);
        setAvatar('🤖');
        setCategoryId(null);
        // Every switch and the config back to a new agent's defaults.
        applyStoredSettings({});
    };

    /** An open agent's config as stored now (Agent Studio may have changed it since); a new agent's starting config. */
    const baseConfigForSave = async (): Promise<Record<string, unknown>> => {
        if (!selectedAgent) return baseConfigRef.current;
        // The save writes the draft, so it merges over the draft's config, not the published one.
        const res = await apiRequest('GET /agents/{id}', { params: { id: selectedAgent.id }, query: DRAFT });
        return storedConfig((await res.json()).config);
    };

    const saveAgent = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            // The server stores the config it is sent whole: merge the designer's
            // fields over the config as stored now (skills, action grants, memory,
            // the chat bubble, written by Agent Studio), never rebuild it.
            const config: Record<string, unknown> = {
                ...(await baseConfigForSave()),
                enableGuardrails, llamaGuardEnabled, webSearchGuardEnabled,
                strictKnowledge, includeSourceReferences,
                disableExternalTools,
                allowCopy,
                knowledge_base_ids: knowledgeBaseIds,
                enabledIntegrations: enabledIntegrations || undefined,
                regexGuardrails: {
                    enabled: regexGuardrailsEnabled,
                    collectionIds: selectedCollections,
                    scope: regexScope,
                    action: guardrailAction
                }
            };
            // null is "every integration": a stored list must not survive the merge.
            if (!enabledIntegrations) delete config.enabledIntegrations;
            const body: AgentSaveBody = {
                name, description, systemPrompt,
                tools: selectedTools, toolParams,
                model: model || null, starterPrompts, avatar,
                workspaceEnabled: workspaceEnabled ? 1 : 0,
                embedEnabled,
                config,
            };
            body.categoryId = categoryId || null;
            // A new agent belongs to the organisation the list is narrowed to, or it would vanish from it.
            if (!selectedAgent && orgId && !systemMode) body.organizationId = orgId;
            if (selectedAgent) {
                // The raw body: the designer sends workspaceEnabled as 1/0, wider than the route's schema type.
                await apiRequest('PUT /agents/{id}', {
                    params: { id: selectedAgent.id },
                    init: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
                });
            } else {
                const res = await apiRequest('POST /agents', { body });
                const newAgent = await res.json();
                setSelectedAgent(newAgent);
                setIsCreating(false);
            }
            fetchAgents();
        } catch (err) { console.error('Failed to save agent:', err); toast.error(messageOf(err, 'Failed to save agent')); } finally {
            setSaving(false);
        }
    };

    const deleteAgent = async (id: string) => {
        if (!(await confirm({ title: 'Delete this agent?', confirmLabel: 'Delete', destructive: true }))) return;
        try {
            try {
                await apiRequest('DELETE /agents/{id}', { params: { id } });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = errorBody(err) ?? {};
                toast.error(data.error || 'Failed to delete agent. Please try again.');
                return;
            }
            if (selectedAgent?.id === id) {
                setSelectedAgent(null);
                setName(''); setDescription(''); setSystemPrompt('');
                setSelectedTools([]); setAllowCopy(true); setEmbedEnabled(false);
                setWorkspaceEnabled(false);
            }
            fetchAgents();
        } catch (err) {
            console.error('Failed to delete agent:', err);
            toast.error('Failed to delete agent. Please try again.');
        }
    };

    const duplicateAgent = async (agent: DesignerAgent) => {
        try {
            const freshRes = await apiFetch('GET /agents/{id}', { params: { id: agent.id } });
            const freshAgent = await freshRes.json();

            setSelectedAgent(null);
            setIsCreating(true);
            setName(`${freshAgent.name || ''} (Copy)`);
            setDescription(freshAgent.description || '');
            setSystemPrompt(freshAgent.system_prompt || '');
            setSelectedTools(freshAgent.tools || []);
            setToolParams(freshAgent.tool_params || {});
            setModel(freshAgent.model || '');
            setIsPublished(false);
            setSharedGroups([]);
            setStarterPrompts(typeof freshAgent.starter_prompts === 'string' ? JSON.parse(freshAgent.starter_prompts || '[]') : (freshAgent.starter_prompts || []));
            setAvatar(freshAgent.avatar || '🤖');
            setCategoryId(freshAgent.category_id || null);

            applyStoredSettings(freshAgent);

            setMessages([]);
            setShowChat(false);
            setActiveSection('identity');
        } catch (err) {
            console.error('Failed to duplicate agent:', err);
        }
    };

    // Send explicit (isPublished, groups) to the publish endpoint. The
    // togglePublish wrapper keeps the legacy "no args = flip" semantics for
    // older callsites; the menu uses setPublishState directly so the user
    // can switch between Personal / Org / Specific Groups in one click.
    const setPublishState = async (nextPublished: boolean, nextGroups: string[] = []) => {
        if (!selectedAgent) return;
        const groups = nextPublished ? (Array.isArray(nextGroups) ? nextGroups : []) : [];
        try {
            setPublishError('');
            const res = await apiFetch('PATCH /agents/{id}/publish', {
                params: { id: selectedAgent.id },
                body: { isPublished: nextPublished, sharedGroups: groups },
            });

            if (res.ok) {
                setIsPublished(nextPublished);
                setSharedGroups(groups);
                setShowPublishMenu(false);
                fetchAgents();
            } else {
                // Inline error instead of alert(): alert() is silently
                // suppressed inside sandboxed iframes (NC embed), and the old
                // res.json() parsing dropped plain-text/HTML bodies (BFSF-220).
                const info = await parseSaveError(res);
                const msg = String(info.message || `Failed to publish agent (${res.status})`).slice(0, 500);
                console.error('Failed to toggle publish:', msg);
                setPublishError(msg);
            }
        } catch (err) {
            console.error('Failed to toggle publish:', err);
            setPublishError('Failed to publish agent. Please check your connection and try again.');
        }
    };
    const togglePublish = (targetGroups: string[] | undefined = undefined) => {
        const nextPublished = targetGroups !== undefined ? true : !isPublished;
        const nextGroups = targetGroups !== undefined ? targetGroups : sharedGroups;
        return setPublishState(nextPublished, nextGroups);
    };

    const toggleTool = (componentId: string) => {
        setSelectedTools(prev =>
            prev.includes(componentId)
                ? prev.filter(id => id !== componentId)
                : [...prev, componentId]
        );
    };

    return {
        fetchAgents, selectAgent, createNewAgent, saveAgent,
        deleteAgent, duplicateAgent, togglePublish, setPublishState, toggleTool,
        confirmDialog,
    };
}
