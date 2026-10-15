/**
 * useModelTiers — loads the chat model-tier config and owns the selected tier.
 *
 * Used by NotebooksPage (it copied the same fetch + the
 * `selectedTier` state). The tier feeds the chat stream, AI-Fill and Studio
 * generation requests.
 */
import { useState, useEffect } from 'react';
import type { ModelTierMap } from '../../../../api/queries/modelTiers';
import { API_BASE, authFetch } from '../../../../utils/helpers';

export default function useModelTiers() {
    const [modelTiers, setModelTiers] = useState<ModelTierMap>({});
    const [selectedTier, setSelectedTier] = useState<string>('auto');

    useEffect(() => {
        authFetch(`${API_BASE}/ai/config/chat-models`)
            .then((r: Response) => (r.ok ? r.json() : {}))
            .then(setModelTiers)
            .catch((e: unknown) => console.warn('[notebooks] load model tiers failed', e));
    }, []);

    return { modelTiers, selectedTier, setSelectedTier };
}
