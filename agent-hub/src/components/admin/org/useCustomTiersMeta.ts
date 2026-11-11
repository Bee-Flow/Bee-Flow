import { useCustomTiersList } from '@/api/queries/orgAdminReads';
import type { CustomTierMeta } from './useOrgDirectory';

/**
 * The custom tiers' pills, next to the four standard tiers in a group's
 * Allowed-tiers editor. Empty `allowedTiers` on a group means "no restriction";
 * non-empty = only those ids are usable by its members. A refusal leaves the list empty.
 * `enabled` false reads nothing (a screen that needs the pills only once an editor is open).
 */
export default function useCustomTiersMeta(enabled = true): CustomTierMeta[] {
    return useCustomTiersList<CustomTierMeta>(enabled);
}
