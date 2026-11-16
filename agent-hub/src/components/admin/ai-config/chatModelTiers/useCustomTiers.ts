import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { CUSTOM_TIER_DEFAULTS, slugifyTierLabel } from './constants';
import type { CustomTier } from './tierTypes';
import { getAiConfig, postAiConfig } from '@/api/aiConfig';
import { useTranslation } from '@/hooks/useTranslation';

type ConfirmFn = (opts: { title: string; description?: string; confirmLabel?: string; destructive?: boolean }) => Promise<boolean>;

export interface CustomTiersState {
    customTiers: CustomTier[];
    setCustomTiers: Dispatch<SetStateAction<CustomTier[]>>;
    expandedCustomId: string | null;
    setExpandedCustomId: Dispatch<SetStateAction<string | null>>;
    loadCustomTiers: () => Promise<void>;
    /** The draft differs from what is stored. */
    customDirty: boolean;
    /**
     * Store the whole array (the server keeps what it can read and says which
     * models it does not know): null when it took it, else what went wrong.
     * `warning` reports the server's notes on a stored array.
     */
    persistCustomTiers: () => Promise<{ error: string | null; warning: string }>;
    discardCustomTiers: () => void;
    addCustomTier: () => void;
    updateCustomTier: (id: string, patch: Partial<CustomTier>) => void;
    renameCustomTier: (currentId: string, newLabel: string) => void;
    removeCustomTier: (id: string) => Promise<void>;
    toggleCustomTaskType: (id: string, taskKey: string) => void;
}

/** ' (warning; warning)' from a custom-tier save, '' when there is none. */
function warningsOf(data: { warnings?: unknown }): string {
    return Array.isArray(data.warnings) && data.warnings.length > 0 ? ` (${data.warnings.join('; ')})` : '';
}

/** A new tier on a placeholder id no other tier has, so its card has a stable key. */
function newCustomTier(existing: readonly CustomTier[]): CustomTier {
    let n = existing.length + 1;
    while (existing.some(t => t.id === `custom:new-tier-${n}`)) n += 1;
    return {
        id: `custom:new-tier-${n}`,
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
    };
}

/** The server's custom tiers, part of the Models page's one draft. */
export default function useCustomTiers(confirm: ConfirmFn): CustomTiersState {
    const { t } = useTranslation();
    const [customTiers, setCustomTiers] = useState<CustomTier[]>([]);
    const [savedTiers, setSavedTiers] = useState<CustomTier[]>([]);
    const [expandedCustomId, setExpandedCustomId] = useState<string | null>(null);

    const loadCustomTiers = async () => {
        try {
            const res = await getAiConfig('custom-chat-models');
            if (res.ok) {
                const data = await res.json();
                const tiers = Array.isArray(data.tiers) ? data.tiers : [];
                setCustomTiers(tiers);
                setSavedTiers(tiers);
            }
        } catch (e) { console.error('Failed to load custom tiers:', e); }
    };

    const persistCustomTiers = async () => {
        try {
            const res = await postAiConfig('custom-chat-models', { tiers: customTiers });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return { error: typeof data.error === 'string' ? data.error : '', warning: '' };
            const kept: CustomTier[] = Array.isArray(data.tiers) ? data.tiers : customTiers;
            setCustomTiers(kept);
            setSavedTiers(kept);
            return { error: null, warning: warningsOf(data) };
        } catch (e) {
            console.error('Failed to save custom tiers:', e);
            return { error: '', warning: '' };
        }
    };

    const addCustomTier = () => {
        const tier = newCustomTier(customTiers);
        setCustomTiers(prev => [...prev, tier]);
        setExpandedCustomId(tier.id);
    };

    const updateCustomTier = (id: string, patch: Partial<CustomTier>) => {
        setCustomTiers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
    };

    const renameCustomTier = (currentId: string, newLabel: string) => {
        const slug = slugifyTierLabel(newLabel);
        // The id follows the name, but never onto another tier's id: every edit
        // finds its tier by id, so two tiers sharing one would be edited as one.
        const newId = slug && !customTiers.some(t => t.id === slug && t.id !== currentId) ? slug : currentId;
        setCustomTiers(prev => prev.map(t => {
            if (t.id !== currentId) return t;
            return { ...t, label: newLabel, id: newId };
        }));
        if (newId !== currentId) setExpandedCustomId(newId);
    };

    const removeCustomTier = async (id: string) => {
        if (!(await confirm({
            title: t('ai_model_setup.custom_delete_title', 'Delete this custom tier?'),
            description: t('ai_model_setup.custom_delete_desc', 'It is removed when you save the page.'),
            confirmLabel: t('ai_model_setup.custom_delete_confirm', 'Delete'),
            destructive: true,
        }))) return;
        setCustomTiers(prev => prev.filter(t => t.id !== id));
    };

    const toggleCustomTaskType = (id: string, taskKey: string) => {
        setCustomTiers(prev => prev.map(t => {
            if (t.id !== id) return t;
            const set = new Set(t.allowedTaskTypes || []);
            if (set.has(taskKey)) set.delete(taskKey);
            else set.add(taskKey);
            return { ...t, allowedTaskTypes: Array.from(set) };
        }));
    };

    return {
        customTiers, setCustomTiers, expandedCustomId, setExpandedCustomId, loadCustomTiers,
        customDirty: JSON.stringify(customTiers) !== JSON.stringify(savedTiers),
        persistCustomTiers, discardCustomTiers: () => setCustomTiers(savedTiers),
        addCustomTier, updateCustomTier, renameCustomTier, removeCustomTier, toggleCustomTaskType,
    };
}
