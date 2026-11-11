import { useEffect, useState } from 'react';
import { API_BASE } from '@/utils/helpers';
import { settled } from '@/api/settled';
import { logger } from '@/utils/logger';
import type { CustomTierMeta } from './useOrgDirectory';

/**
 * The custom tiers' pills, next to the four standard tiers in a group's
 * Allowed-tiers editor. Empty `allowedTiers` on a group means "no restriction";
 * non-empty = only those ids are usable by its members. A refusal leaves the list empty.
 * `enabled` false reads nothing (a screen that needs the pills only once an editor is open).
 */
export default function useCustomTiersMeta(enabled = true): CustomTierMeta[] {
    const [tiers, setTiers] = useState<CustomTierMeta[]>([]);
    useEffect(() => {
        if (!enabled) return;
        (async () => {
            try {
                const res = await settled(`${API_BASE}/ai/config/custom-tiers-list`, undefined, 'empty');
                if (res.ok) {
                    const data: { tiers?: CustomTierMeta[] } | null = await res.res.json();
                    if (Array.isArray(data?.tiers)) setTiers(data.tiers);
                }
            } catch (err) { logger.debug('non-critical', err); }
        })();
    }, [enabled]);
    return tiers;
}
