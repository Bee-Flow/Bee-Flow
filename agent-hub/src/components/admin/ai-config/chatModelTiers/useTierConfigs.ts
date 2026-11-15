import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TierConfig } from './tierTypes';
import { getAiConfig, postAiConfig } from '@/api/aiConfig';

const initialTiers = (): TierConfig => ({
    fast: { modelId: '', label: 'Fast' },
    standard: { modelId: '', label: 'Flow (Direct)' },
    swarm: { modelId: '', label: 'Swarm (Direct)' },
    thinking: { modelId: '', label: 'Thinking' },
    writer: { modelId: '', label: 'Writer' },
    pro: { modelId: '', label: 'Deep Thinking' }
});

/** One tier table (regular or EU) as part of the page's draft. */
interface TierTableDraft {
    config: TierConfig;
    setConfig: Dispatch<SetStateAction<TierConfig>>;
    dirty: boolean;
    load: () => Promise<void>;
    /** Store the draft: null when the server took it, else what went wrong. */
    persist: () => Promise<string | null>;
    discard: () => void;
}

export interface TierConfigsState {
    config: TierConfig;
    setConfig: Dispatch<SetStateAction<TierConfig>>;
    euConfig: TierConfig;
    setEuConfig: Dispatch<SetStateAction<TierConfig>>;
    tiersDirty: boolean;
    euDirty: boolean;
    expandedTier: string | null;
    setExpandedTier: Dispatch<SetStateAction<string | null>>;
    /** The EU table opens its own rows: a Flow row open above does not open the EU one. */
    expandedEuTier: string | null;
    setExpandedEuTier: Dispatch<SetStateAction<string | null>>;
    loadConfig: () => Promise<void>;
    loadEuConfig: () => Promise<void>;
    persistTiers: () => Promise<string | null>;
    persistEu: () => Promise<string | null>;
    discardTiers: () => void;
    updateTier: (tierKey: string, field: string, value: unknown) => void;
    updateEuTier: (tierKey: string, field: string, value: unknown) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function useTierTable(path: 'chat-models' | 'chat-models-eu'): TierTableDraft {
    const [config, setConfig] = useState<TierConfig>(initialTiers);
    const [saved, setSaved] = useState<TierConfig>(initialTiers);

    const load = async () => {
        try {
            const res = await getAiConfig(path);
            if (res.ok) {
                const data = await res.json();
                setConfig(data);
                setSaved(data);
            }
        } catch (e) { console.error(`Failed to load ${path}:`, e); }
    };

    const persist = async () => {
        try {
            const res = await postAiConfig(path, config);
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                return typeof data.error === 'string' ? data.error : '';
            }
            setSaved(config);
            return null;
        } catch (e) {
            console.error(`Failed to save ${path}:`, e);
            return '';
        }
    };

    return { config, setConfig, dirty: !same(config, saved), load, persist, discard: () => setConfig(saved) };
}

/**
 * The standard tiers, global and EU-only, as part of the Models page's one
 * draft: each table knows what is stored, whether the draft differs, and how
 * to store itself. The page's save bar runs the stores (useChatModelTiersState).
 */
export default function useTierConfigs(): TierConfigsState {
    const regular = useTierTable('chat-models');
    const eu = useTierTable('chat-models-eu');
    const [expandedTier, setExpandedTier] = useState<string | null>(null);
    const [expandedEuTier, setExpandedEuTier] = useState<string | null>(null);

    const update = (set: Dispatch<SetStateAction<TierConfig>>) => (tierKey: string, field: string, value: unknown) => {
        set(prev => ({ ...prev, [tierKey]: { ...prev[tierKey], [field]: value } }));
    };

    return {
        config: regular.config, setConfig: regular.setConfig,
        euConfig: eu.config, setEuConfig: eu.setConfig,
        tiersDirty: regular.dirty, euDirty: eu.dirty,
        expandedTier, setExpandedTier, expandedEuTier, setExpandedEuTier,
        loadConfig: regular.load, loadEuConfig: eu.load,
        persistTiers: regular.persist, persistEu: eu.persist,
        discardTiers: () => { regular.discard(); eu.discard(); },
        updateTier: update(regular.setConfig), updateEuTier: update(eu.setConfig),
    };
}
