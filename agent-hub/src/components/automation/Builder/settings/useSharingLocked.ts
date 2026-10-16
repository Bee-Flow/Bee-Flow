import { useEntitlements } from '../../../licensing/EntitlementsContext';

/**
 * Sharing an automation is a plan feature (`automation_sharing`). Only a real
 * answer locks: while the entitlements load (or failed) the controls stay
 * usable and the server has the last word.
 */
export function useSharingLocked(): boolean {
    const { lockReason, loading, error } = useEntitlements();
    if (loading || error || typeof lockReason !== 'function') return false;
    return lockReason('automation_sharing') != null;
}
