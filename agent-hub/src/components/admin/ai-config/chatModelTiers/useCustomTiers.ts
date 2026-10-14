import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { CUSTOM_TIER_DEFAULTS, slugifyTierLabel } from './constants';
import type { CustomTier } from './tierTypes';
import { API_BASE, authFetch } from '../../../../utils/helpers';

type ConfirmFn = (opts: { title: string; description?: string; confirmLabel?: string; destructive?: boolean }) => Promise<boolean>;

export interface CustomTiersState {
    customTiers: CustomTier[];
    setCustomTiers: Dispatch<SetStateAction<CustomTier[]>>;
    expandedCustomId: string | null;
    setExpandedCustomId: Dispatch<SetStateAction<string | null>>;
    loadCustomTiers: () => Promise<void>;
    addCustomTier: () => void;
    updateCustomTier: (id: string, patch: Partial<CustomTier>) => void;
    renameCustomTier: (currentId: string, newLabel: string) => void;
    removeCustomTier: (id: string) => Promise<void>;
    toggleCustomTaskType: (id: string, taskKey: string) => void;
}

/** The org's custom tiers, edited locally; the tier saves send the whole array. */
export default function useCustomTiers(confirm: ConfirmFn): CustomTiersState {
    const [customTiers, setCustomTiers] = useState<CustomTier[]>([]);
    const [expandedCustomId, setExpandedCustomId] = useState<string | null>(null);

    const loadCustomTiers = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/custom-chat-models`);
            if (res.ok) {
                const data = await res.json();
                setCustomTiers(Array.isArray(data.tiers) ? data.tiers : []);
            }
        } catch (e) { console.error('Failed to load custom tiers:', e); }
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

    const updateCustomTier = (id: string, patch: Partial<CustomTier>) => {
        setCustomTiers(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
    };

    const renameCustomTier = (currentId: string, newLabel: string) => {
        const newId = slugifyTierLabel(newLabel);
        setCustomTiers(prev => prev.map(t => {
            if (t.id !== currentId) return t;
            return { ...t, label: newLabel, id: newId || currentId };
        }));
        if (newId && newId !== currentId) setExpandedCustomId(newId);
    };

    const removeCustomTier = async (id: string) => {
        if (!(await confirm({ title: 'Delete this custom tier?', description: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true }))) return;
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
        addCustomTier, updateCustomTier, renameCustomTier, removeCustomTier, toggleCustomTaskType,
    };
}
