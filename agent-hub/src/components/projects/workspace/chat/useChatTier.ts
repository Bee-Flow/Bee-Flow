// The response depth a team chat message asks the AI for: the same slider a
// normal chat has, over the same tiers, but only the depths (Fast, Thinking,
// Pro, Deep thinking, and Auto to let the server choose): Flow, Swarm and
// custom tiers are kinds of work, and one answer in a chat is not that.

import { useCallback, useMemo, useState } from 'react';
import { useModelTiersQuery, type ModelTierMap } from '../../../../api/queries/modelTiers';
import scopedStorage from '../../../../utils/scopedStorage';
import { DEPTH_TIER_KEYS } from '../../../licensing/tierMeta';

const STORAGE_KEY = 'projectChatTier';

export interface ChatTier { tiers: ModelTierMap; value: string; onChange: (tier: string) => void }

function stored(): string | null {
    try { return scopedStorage.getItem(STORAGE_KEY); } catch { return null; }
}

/** The depth tiers this member may use, the current pick, and how to change it. `null` while nothing can be offered. */
export function useChatTier(): ChatTier | null {
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
    // A remembered tier that is no longer offered gives way to the default.
    const value = picked && (picked === 'auto' || tiers[picked]) ? picked : 'fast';
    return { tiers, value, onChange };
}
