// The response depth a spreadsheet assistant question asks for: the same
// slider as a chat (Auto, Fast, Think, Deep Thinking), remembered under its
// own key. Same pattern as projects/workspace/chat/useChatTier.

import { useCallback, useMemo, useState } from 'react';
import { useModelTiersQuery, type ModelTierMap } from '../../../api/queries/modelTiers';
import { DEPTH_TIER_KEYS } from '../../../components/licensing/tierMeta';
import scopedStorage from '../../../utils/scopedStorage';

const STORAGE_KEY = 'sheetAssistantTier';

export interface AssistantTier { tiers: ModelTierMap; value: string; onChange: (tier: string) => void }

function stored(): string | null {
    try { return scopedStorage.getItem(STORAGE_KEY); } catch { return null; }
}

/** The depth tiers this person may use, the current pick and how to change it. `null` while nothing can be offered. */
export default function useAssistantTier(): AssistantTier | null {
    const query = useModelTiersQuery('direct_chat');
    const [picked, setPicked] = useState<string | null>(stored);
    const tiers = useMemo<ModelTierMap>(
        () => Object.fromEntries(Object.entries(query.data || {}).filter(([k]) => DEPTH_TIER_KEYS.includes(k))),
        [query.data],
    );
    const onChange = useCallback((tier: string) => {
        setPicked(tier);
        try { scopedStorage.setItem(STORAGE_KEY, tier); } catch { /* the pick just does not outlive the page */ }
    }, []);
    if (!Object.keys(tiers).length) return null;
    const value = picked && (picked === 'auto' || tiers[picked]) ? picked : 'auto';
    return { tiers, value, onChange };
}
