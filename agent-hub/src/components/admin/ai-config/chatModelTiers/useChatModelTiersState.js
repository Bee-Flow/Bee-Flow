// State core of ChatModelTiersConfig — every useState, the initial load
// effect, all loaders/savers/mutators and the derived model lists, moved
// verbatim from ChatModelTiersConfig.jsx. Called first (and only) in the
// panel so all state stays owned by the panel's fiber; the section
// components receive these bindings by explicit threading.
import { useEffect, useState } from 'react';
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER, CUSTOM_TIER_DEFAULTS, slugifyTierLabel } from './constants';
import { getModelMeta, isReasoningCapable } from './modelMeta';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import useConfirm from '../../../shared/useConfirm';

export default function useChatModelTiersState(allModels) {
    const { confirm, confirmDialog } = useConfirm();
    const [config, setConfig] = useState({
        fast: { modelId: '', label: 'Fast' },
        standard: { modelId: '', label: 'Flow (Direct)' },
        swarm: { modelId: '', label: 'Swarm (Direct)' },
        thinking: { modelId: '', label: 'Thinking' },
        writer: { modelId: '', label: 'Writer' },
        pro: { modelId: '', label: 'Deep Thinking' }
    });
    const [euConfig, setEuConfig] = useState({
        fast: { modelId: '', label: 'Fast' },
        standard: { modelId: '', label: 'Flow (Direct)' },
        swarm: { modelId: '', label: 'Swarm (Direct)' },
        thinking: { modelId: '', label: 'Thinking' },
        writer: { modelId: '', label: 'Writer' },
        pro: { modelId: '', label: 'Deep Thinking' }
    });
    const [customTiers, setCustomTiers] = useState([]);
    const [customMessage, setCustomMessage] = useState(null);
    const [customSaving, setCustomSaving] = useState(false);
    const [saving, setSaving] = useState(false);
    const [euSaving, setEuSaving] = useState(false);
    const [message, setMessage] = useState(null);
    const [euMessage, setEuMessage] = useState(null);
    const [expandedTier, setExpandedTier] = useState(null);
    const [expandedCustomId, setExpandedCustomId] = useState(null);
    const [classifierModel, setClassifierModel] = useState('');
    const [classifierSaving, setClassifierSaving] = useState(false);
    const [classifierMessage, setClassifierMessage] = useState(null);
    const [titleModel, setTitleModel] = useState('');
    const [titleModelSaving, setTitleModelSaving] = useState(false);
    const [titleModelMessage, setTitleModelMessage] = useState(null);
    const [memoryModel, setMemoryModel] = useState('');
    const [memoryModelSaving, setMemoryModelSaving] = useState(false);
    const [memoryModelMessage, setMemoryModelMessage] = useState(null);
    // TEMPORARY ai_step override — same contract as the memory model, one key.
    const [aiStepModel, setAiStepModel] = useState('');
    const [aiStepModelSaving, setAiStepModelSaving] = useState(false);
    const [aiStepModelMessage, setAiStepModelMessage] = useState(null);
    // The routine Extract data step's own model — same contract, key
    // `data_extraction_model`. Separate from the ai_step override on purpose.
    const [dataExtractionModel, setDataExtractionModel] = useState('');
    const [dataExtractionModelSaving, setDataExtractionModelSaving] = useState(false);
    const [dataExtractionModelMessage, setDataExtractionModelMessage] = useState(null);
    const [hiddenModelIds, setHiddenModelIds] = useState([]);
    const [claudeAutoRetry, setClaudeAutoRetry] = useState(true);
    const [claudeSaving, setClaudeSaving] = useState(false);
    const [claudeMessage, setClaudeMessage] = useState(null);
    const [claudeRecAppliedTier, setClaudeRecAppliedTier] = useState(null);

    useEffect(() => {
        loadConfig();
        loadEuConfig();
        loadCustomTiers();
        loadClassifierModel();
        loadTitleModel();
        loadMemoryModel();
        loadAiStepModel();
        loadDataExtractionModel();
        loadHiddenModels();
        loadClaudeSettings();
    }, []);

    const loadClaudeSettings = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/claude-settings`);
            if (res.ok) {
                const data = await res.json();
                setClaudeAutoRetry(data.autoRetryOnEmpty !== false);
            }
        } catch (e) { console.error('Failed to load Claude settings:', e); }
    };

    const saveClaudeSettings = async (next = claudeAutoRetry) => {
        setClaudeSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/claude-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoRetryOnEmpty: next }),
            });
            if (res.ok) {
                setClaudeMessage({ type: 'success', text: 'Claude settings saved' });
                setTimeout(() => setClaudeMessage(null), 3000);
            } else {
                setClaudeMessage({ type: 'error', text: 'Failed to save Claude settings' });
            }
        } catch (e) {
            setClaudeMessage({ type: 'error', text: 'Failed to save Claude settings' });
        }
        setClaudeSaving(false);
    };

    // Patch the local tier `config` state with the recommended Claude values.
    // The admin still has to hit "Save Tier Configuration" to persist — keeps
    // the action reviewable. Flashing the row provides feedback.
    const applyClaudeRecommendedForTier = (tierKey) => {
        const rec = CLAUDE_RECOMMENDED[tierKey];
        if (!rec) return;
        setConfig(prev => ({
            ...prev,
            [tierKey]: {
                ...(prev[tierKey] || {}),
                modelId: rec.modelId,
                maxTokens: rec.maxTokens,
                temperature: rec.temperature,
                reasoningEffort: rec.reasoningEffort,
                reasoningSummary: rec.reasoningSummary,
                budgetTokens: rec.budgetTokens,
            },
        }));
        setClaudeRecAppliedTier(tierKey);
        setTimeout(() => setClaudeRecAppliedTier(curr => curr === tierKey ? null : curr), 1500);
    };

    const applyAllClaudeRecommended = () => {
        const next = { ...config };
        for (const tierKey of CLAUDE_REC_TIER_ORDER) {
            const rec = CLAUDE_RECOMMENDED[tierKey];
            if (!rec) continue;
            next[tierKey] = {
                ...(next[tierKey] || {}),
                modelId: rec.modelId,
                maxTokens: rec.maxTokens,
                temperature: rec.temperature,
                reasoningEffort: rec.reasoningEffort,
                reasoningSummary: rec.reasoningSummary,
                budgetTokens: rec.budgetTokens,
            };
        }
        setConfig(next);
        setClaudeMessage({ type: 'success', text: 'Recommended Claude defaults applied to all tiers — click Save Tier Configuration to persist.' });
        setTimeout(() => setClaudeMessage(null), 5000);
    };

    const loadHiddenModels = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/hidden-models`);
            if (res.ok) {
                const data = await res.json();
                setHiddenModelIds(Array.isArray(data.modelIds) ? data.modelIds : []);
            }
        } catch (e) { console.error('Failed to load hidden models:', e); }
    };

    // Optimistically toggle and persist. Roll back on failure so the picker
    // and the server never disagree.
    const toggleHiddenModel = async (modelId) => {
        const prev = hiddenModelIds;
        const next = prev.includes(modelId)
            ? prev.filter(id => id !== modelId)
            : [...prev, modelId];
        setHiddenModelIds(next);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/hidden-models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelIds: next }),
            });
            if (!res.ok) throw new Error('save failed');
            const data = await res.json();
            if (Array.isArray(data.modelIds)) setHiddenModelIds(data.modelIds);
        } catch (e) {
            console.error('Failed to save hidden models:', e);
            setHiddenModelIds(prev);
        }
    };

    const loadClassifierModel = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/auto-classifier`);
            if (res.ok) {
                const data = await res.json();
                setClassifierModel(typeof data.modelId === 'string' ? data.modelId : '');
            }
        } catch (e) { console.error('Failed to load classifier model:', e); }
    };

    const saveClassifierModel = async (next = classifierModel) => {
        setClassifierSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/auto-classifier`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: next || null }),
            });
            if (res.ok) {
                const data = await res.json();
                setClassifierModel(typeof data.modelId === 'string' ? data.modelId : '');
                setClassifierMessage({ type: 'success', text: 'Classifier model saved' });
                setTimeout(() => setClassifierMessage(null), 3000);
            } else {
                const data = await res.json().catch(() => ({}));
                setClassifierMessage({ type: 'error', text: data.error || 'Failed to save classifier model' });
            }
        } catch (e) {
            setClassifierMessage({ type: 'error', text: 'Failed to save classifier model' });
        }
        setClassifierSaving(false);
    };

    const loadTitleModel = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/title-model`);
            if (res.ok) {
                const data = await res.json();
                setTitleModel(typeof data.modelId === 'string' ? data.modelId : '');
            }
        } catch (e) { console.error('Failed to load title model:', e); }
    };

    const saveTitleModel = async (next = titleModel) => {
        setTitleModelSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/title-model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: next || null }),
            });
            if (res.ok) {
                const data = await res.json();
                setTitleModel(typeof data.modelId === 'string' ? data.modelId : '');
                setTitleModelMessage({ type: 'success', text: 'Title model saved' });
                setTimeout(() => setTitleModelMessage(null), 3000);
            } else {
                const data = await res.json().catch(() => ({}));
                setTitleModelMessage({ type: 'error', text: data.error || 'Failed to save title model' });
            }
        } catch (e) {
            setTitleModelMessage({ type: 'error', text: 'Failed to save title model' });
        }
        setTitleModelSaving(false);
    };

    // Memory-extraction model — same contract as the title model, one key.
    const loadMemoryModel = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/memory-extraction-model`);
            if (res.ok) {
                const data = await res.json();
                setMemoryModel(typeof data.modelId === 'string' ? data.modelId : '');
            }
        } catch (e) { console.error('Failed to load memory extraction model:', e); }
    };

    const saveMemoryModel = async (next = memoryModel) => {
        setMemoryModelSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/memory-extraction-model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: next || null }),
            });
            if (res.ok) {
                const data = await res.json();
                setMemoryModel(typeof data.modelId === 'string' ? data.modelId : '');
                setMemoryModelMessage({ type: 'success', text: 'Memory extraction model saved' });
                setTimeout(() => setMemoryModelMessage(null), 3000);
            } else {
                const data = await res.json().catch(() => ({}));
                setMemoryModelMessage({ type: 'error', text: data.error || 'Failed to save memory extraction model' });
            }
        } catch (e) {
            setMemoryModelMessage({ type: 'error', text: 'Failed to save memory extraction model' });
        }
        setMemoryModelSaving(false);
    };

    // AI step model (temporary override) — same contract, key `ai_step_model`.
    const loadAiStepModel = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/ai-step-model`);
            if (res.ok) {
                const data = await res.json();
                setAiStepModel(typeof data.modelId === 'string' ? data.modelId : '');
            }
        } catch (e) { console.error('Failed to load AI step model:', e); }
    };

    const saveAiStepModel = async (next = aiStepModel) => {
        setAiStepModelSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/ai-step-model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: next || null }),
            });
            if (res.ok) {
                const data = await res.json();
                setAiStepModel(typeof data.modelId === 'string' ? data.modelId : '');
                setAiStepModelMessage({ type: 'success', text: 'AI step model saved' });
                setTimeout(() => setAiStepModelMessage(null), 3000);
            } else {
                const data = await res.json().catch(() => ({}));
                setAiStepModelMessage({ type: 'error', text: data.error || 'Failed to save AI step model' });
            }
        } catch (e) {
            setAiStepModelMessage({ type: 'error', text: 'Failed to save AI step model' });
        }
        setAiStepModelSaving(false);
    };

    // Data extraction model — same contract, key `data_extraction_model`.
    const loadDataExtractionModel = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/data-extraction-model`);
            if (res.ok) {
                const data = await res.json();
                setDataExtractionModel(typeof data.modelId === 'string' ? data.modelId : '');
            }
        } catch (e) { console.error('Failed to load data extraction model:', e); }
    };

    const saveDataExtractionModel = async (next = dataExtractionModel) => {
        setDataExtractionModelSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/data-extraction-model`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: next || null }),
            });
            if (res.ok) {
                const data = await res.json();
                setDataExtractionModel(typeof data.modelId === 'string' ? data.modelId : '');
                setDataExtractionModelMessage({ type: 'success', text: 'Data extraction model saved' });
                setTimeout(() => setDataExtractionModelMessage(null), 3000);
            } else {
                const data = await res.json().catch(() => ({}));
                setDataExtractionModelMessage({ type: 'error', text: data.error || 'Failed to save data extraction model' });
            }
        } catch (e) {
            setDataExtractionModelMessage({ type: 'error', text: 'Failed to save data extraction model' });
        }
        setDataExtractionModelSaving(false);
    };

    const loadConfig = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/chat-models`);
            if (res.ok) setConfig(await res.json());
        } catch (e) { console.error('Failed to load chat model tiers:', e); }
    };

    const loadEuConfig = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/chat-models-eu`);
            if (res.ok) setEuConfig(await res.json());
        } catch (e) { console.error('Failed to load EU chat model tiers:', e); }
    };

    const save = async () => {
        setSaving(true);
        try {
            // Save standard tiers + custom tiers together so a single click
            // persists everything the user edited in this section.
            const [res, customRes] = await Promise.all([
                authFetch(`${API_BASE}/ai/config/chat-models`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                }),
                authFetch(`${API_BASE}/ai/config/custom-chat-models`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tiers: customTiers })
                })
            ]);
            const bothOk = res.ok && customRes.ok;
            let warn = '';
            try {
                const j = customRes.ok ? await customRes.json() : null;
                if (j && Array.isArray(j.warnings) && j.warnings.length > 0) warn = ' (' + j.warnings.join('; ') + ')';
                if (j && Array.isArray(j.tiers)) setCustomTiers(j.tiers);
            } catch (_) { /* ignore */ }
            if (bothOk) {
                setMessage({ type: warn ? 'warning' : 'success', text: `Chat model tiers saved${warn}` });
                setTimeout(() => setMessage(null), 4000);
            } else {
                setMessage({ type: 'error', text: 'Failed to save (one or more configs)' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save tier config' });
        }
        setSaving(false);
    };

    const loadCustomTiers = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/custom-chat-models`);
            if (res.ok) {
                const data = await res.json();
                setCustomTiers(Array.isArray(data.tiers) ? data.tiers : []);
            }
        } catch (e) { console.error('Failed to load custom tiers:', e); }
    };

    const saveCustomTiers = async (next = customTiers) => {
        setCustomSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/custom-chat-models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tiers: next }),
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.tiers)) setCustomTiers(data.tiers);
                const warn = Array.isArray(data.warnings) && data.warnings.length > 0
                    ? `Saved, with warnings: ${data.warnings.join('; ')}`
                    : 'Custom tiers saved!';
                setCustomMessage({ type: data.warnings?.length ? 'warning' : 'success', text: warn });
                setTimeout(() => setCustomMessage(null), 4000);
            } else {
                setCustomMessage({ type: 'error', text: 'Failed to save custom tiers' });
            }
        } catch (e) {
            setCustomMessage({ type: 'error', text: 'Failed to save custom tiers' });
        }
        setCustomSaving(false);
    };

    const addCustomTier = () => {
        // Generate a unique placeholder id so the new card has a stable key
        let n = customTiers.length + 1;
        let placeholderId = `custom:new-tier-${n}`;
        while (customTiers.some(t => t.id === placeholderId)) {
            n += 1;
            placeholderId = `custom:new-tier-${n}`;
        }
        setCustomTiers(prev => [
            ...prev,
            {
                id: placeholderId,
                label: `New tier ${n}`,
                icon: '✨',
                description: '',
                modelId: '',
                maxTokens: CUSTOM_TIER_DEFAULTS.maxTokens,
                temperature: CUSTOM_TIER_DEFAULTS.temperature,
                reasoningEffort: undefined,
                reasoningSummary: false,
                allowedTaskTypes: ['direct_chat', 'agent_chat'],
                _isNew: true, // local-only flag: show the label/id editor pre-expanded
            },
        ]);
        setExpandedCustomId(placeholderId);
    };

    const updateCustomTier = (id, patch) => {
        setCustomTiers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
    };

    const renameCustomTier = (currentId, newLabel) => {
        const newId = slugifyTierLabel(newLabel);
        setCustomTiers(prev => {
            const next = prev.map(t => {
                if (t.id !== currentId) return t;
                return { ...t, label: newLabel, id: newId || currentId };
            });
            return next;
        });
        if (newId && newId !== currentId) setExpandedCustomId(newId);
    };

    const removeCustomTier = async (id) => {
        if (!(await confirm({ title: 'Delete this custom tier?', description: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true }))) return;
        setCustomTiers(prev => prev.filter(t => t.id !== id));
    };

    const toggleCustomTaskType = (id, taskKey) => {
        setCustomTiers(prev => prev.map(t => {
            if (t.id !== id) return t;
            const set = new Set(t.allowedTaskTypes || []);
            if (set.has(taskKey)) set.delete(taskKey);
            else set.add(taskKey);
            return { ...t, allowedTaskTypes: Array.from(set) };
        }));
    };

    const saveEu = async () => {
        setEuSaving(true);
        try {
            // Save EU standard tiers AND the full custom tiers array (which now
            // contains each custom tier's euModelId). The custom-chat-models
            // endpoint overwrites wholesale so race with `save()` is avoided as
            // long as both callers write from the same local state.
            const [res, customRes] = await Promise.all([
                authFetch(`${API_BASE}/ai/config/chat-models-eu`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(euConfig)
                }),
                authFetch(`${API_BASE}/ai/config/custom-chat-models`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tiers: customTiers })
                })
            ]);
            if (res.ok && customRes.ok) {
                setEuMessage({ type: 'success', text: 'EU model tiers saved!' });
                setTimeout(() => setEuMessage(null), 3000);
            } else {
                setEuMessage({ type: 'error', text: 'Failed to save' });
            }
        } catch (e) {
            setEuMessage({ type: 'error', text: 'Failed to save EU tier config' });
        }
        setEuSaving(false);
    };

    // Filter to only chat-compatible models. A category the server stamped
    // wins over the bundled table: the server read it from the provider's own
    // model list (Mistral's /v1/models says which models cannot chat), while
    // the table matches by prefix — `codestral-embed` looked like Codestral.
    const chatModels = allModels.filter(m => {
        const cat = m.cat || getModelMeta(m.id)?.cat || '';
        return !['Embedding', 'OCR', 'Moderation', 'Audio'].includes(cat);
    });

    // Self-hosted reasoning models (Qwen3, DeepSeek-R1, gpt-oss, …) take the
    // same none/low/medium/high effort scale: the local adapter maps it onto
    // Ollama's `think` levels and vLLM's `enable_thinking`. The bundled regex
    // tables only know cloud model ids, so the flags the server stamped on the
    // model are what tells us here.
    const localModelIds = new Set(chatModels.filter(m => m.local).map(m => m.id));
    const localReasoningIds = new Set(chatModels.filter(m => m.local && m.reasoning).map(m => m.id));
    // A model that carries its own effort vocabulary (Mistral Small 4 and
    // Medium 3.5: none/high) is reasoning-capable on the server's word too.
    const stampedReasoningIds = new Set(chatModels.filter(m => m.reasoning && Array.isArray(m.efforts)).map(m => m.id));
    const isLocal = (id) => localModelIds.has(id);
    const reasoningCapable = (id) => isReasoningCapable(id) || localReasoningIds.has(id) || stampedReasoningIds.has(id);

    const updateTier = (tierKey, field, value) => {
        setConfig(prev => ({
            ...prev,
            [tierKey]: { ...prev[tierKey], [field]: value }
        }));
    };

    const updateEuTier = (tierKey, field, value) => {
        setEuConfig(prev => ({
            ...prev,
            [tierKey]: { ...prev[tierKey], [field]: value }
        }));
    };

    // Build grouped model list (reused by both sections)
    const byProvider = {};
    chatModels.forEach(m => {
        const key = m.providerName || 'Unknown';
        if (!byProvider[key]) byProvider[key] = [];
        byProvider[key].push(m);
    });

    return {
        config, euConfig, customTiers, saving, euSaving, message, euMessage, expandedTier, setExpandedTier,
        expandedCustomId, setExpandedCustomId, classifierModel, setClassifierModel, classifierSaving,
        classifierMessage, titleModel, setTitleModel, titleModelSaving, titleModelMessage, hiddenModelIds,
        memoryModel, setMemoryModel, memoryModelSaving, memoryModelMessage, saveMemoryModel,
        aiStepModel, setAiStepModel, aiStepModelSaving, aiStepModelMessage, saveAiStepModel,
        dataExtractionModel, setDataExtractionModel, dataExtractionModelSaving, dataExtractionModelMessage, saveDataExtractionModel,
        claudeAutoRetry, setClaudeAutoRetry, claudeSaving, claudeMessage, claudeRecAppliedTier,
        saveClaudeSettings, applyClaudeRecommendedForTier, applyAllClaudeRecommended, toggleHiddenModel,
        saveClassifierModel, saveTitleModel, save, saveEu, addCustomTier, updateCustomTier, renameCustomTier,
        removeCustomTier, toggleCustomTaskType, chatModels, isLocal, reasoningCapable, updateTier,
        updateEuTier, byProvider, confirmDialog,
    };
}
