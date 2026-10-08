import { useEffect, useState } from 'react';
import { useModelTiersQuery, type ModelTierConfig, type ModelTierMap } from '../api/queries/modelTiers';
import scopedStorage from '../utils/scopedStorage';

export type { ModelTierConfig, ModelTierMap };

export interface ModelTierSelectionOptions {
    storageKey: string;
    taskType?: string;
}

export interface ModelTierSelection {
    modelTiers: ModelTierMap;
    selectedTier: string;
    setSelectedTier: (tier: string) => void;
}

const NO_TIERS: ModelTierMap = Object.freeze({});

/**
 * Model-tier list + persisted selection for AI-builder composers.
 *
 * Encapsulates the tier plumbing both builders (automations BuilderShell,
 * App Studio BuilderChatPane) need around <ModelTierSelector/>:
 *   - the permission- and task-aware tier list from
 *     `api/queries/modelTiers`, which every composer on the screen shares
 *     rather than each paying its own round-trip,
 *   - persist the selected tier per user under `storageKey` (scopedStorage),
 *   - stale-tier fallback: when storage held a tier the server no longer
 *     returns (beta revoked, custom tier deleted), snap back to 'auto' so
 *     the picker doesn't show an undefined slot.
 *
 * NOTE: distinct from pages/documents/notebook/hooks/useModelTiers.js, which fetches
 * the unfiltered /ai/config/chat-models list and keeps no selection state.
 */
export default function useModelTierSelection(
    { storageKey, taskType = 'direct_chat' }: ModelTierSelectionOptions,
): ModelTierSelection {
    const query = useModelTiersQuery(taskType);
    const modelTiers = query.data ?? NO_TIERS;
    const [selectedTier, setSelectedTier] = useState<string>(
        () => scopedStorage.getItem(storageKey) || 'auto',
    );

    useEffect(() => {
        scopedStorage.setItem(storageKey, selectedTier);
    }, [storageKey, selectedTier]);

    useEffect(() => {
        const keys = Object.keys(modelTiers);
        if (keys.length === 0) return;
        if (!keys.includes(selectedTier)) {
            setSelectedTier(keys.includes('auto') ? 'auto' : keys[0]);
        }
    }, [modelTiers, selectedTier]);

    return { modelTiers, selectedTier, setSelectedTier };
}
