/**
 * useModelTiers — loads the chat model-tier config and owns the selected tier.
 *
 * Used by NotebooksPage (it copied the same fetch + the
 * `selectedTier` state). The tier feeds the chat stream, AI-Fill and Studio
 * generation requests.
 */
import { useState } from 'react';
import type { ModelTierMap } from '@/api/queries/modelTiers';
import { useConfigChatModels } from '@/api/queries/configModels';

const EMPTY_MODEL_TIERS: ModelTierMap = {};

export default function useModelTiers() {
    const [selectedTier, setSelectedTier] = useState<string>('auto');

    const modelTiersQuery = useConfigChatModels();
    const modelTiers = modelTiersQuery.data ?? EMPTY_MODEL_TIERS;

    return { modelTiers, selectedTier, setSelectedTier };
}
