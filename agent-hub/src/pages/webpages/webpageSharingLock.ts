import { useEntitlements } from '../../components/licensing/EntitlementsContext';
import type { TranslateFn } from '../../hooks/useTranslation';

/**
 * Webpage sharing is the Enterprise capability `webpage_sharing` (the
 * enterprise split, 2026-10). Building, previewing and keeping your own pages
 * is Community; handing a page to anyone else is not: publishing it to the
 * organisation or to groups, new public links, making it public.
 *
 * The server is the authority (routes/webpages/sharingGate.js) and refuses
 * only what WIDENS: what is already shared stays shared, and stopping to
 * share is never refused. The screens follow the same line, so these helpers
 * only ever lock the controls that add an audience.
 */

export const WEBPAGE_SHARING = 'webpage_sharing';

type EntitlementsView = {
    lockReason?: (id: string) => string | null;
    loading?: boolean;
    error?: unknown;
};

/**
 * Why sharing is locked for this person ('not_granted' = the plan has it and
 * the organisation did not switch it on; anything else = the plan does not
 * include it), or null when it is not locked. Only a real answer locks: while
 * the entitlements load, or when their fetch failed, the controls stay usable
 * and the server has the last word.
 */
export function useWebpageSharingLock(): string | null {
    const { lockReason, loading, error } = useEntitlements() as unknown as EntitlementsView;
    if (loading || error || typeof lockReason !== 'function') return null;
    return lockReason(WEBPAGE_SHARING) || null;
}

/** The sentence for a lock reason: ask an admin, or a higher plan. */
export function sharingLockText(reason: string | null | undefined, t: TranslateFn): string {
    if (reason === 'not_granted') {
        return t('webpages.sharing.locked_not_granted',
            'Sharing webpages is not switched on for your organisation, so ask an admin. Your own pages keep working, and what is already shared stays shared.');
    }
    return t('webpages.sharing.locked_upgrade',
        'Sharing a webpage with others is available on a higher plan. Your own pages keep working, what is already shared stays shared, and you can always stop sharing.');
}

/**
 * A readable sentence for the server's refusal of a sharing request, or null
 * when the answer is something else. requireCapability answers
 * `{ error: 'feature_locked' | 'feature_disabled', feature }`, and a bare
 * `feature_locked` in a red line tells nobody anything.
 */
export function sharingRefusalText(status: number, body: unknown, t: TranslateFn): string | null {
    if (status !== 403 || !body || typeof body !== 'object') return null;
    const { error, feature } = body as { error?: unknown; feature?: unknown };
    if (feature !== WEBPAGE_SHARING) return null;
    if (error === 'feature_disabled') return sharingLockText('not_granted', t);
    if (error === 'feature_locked') return sharingLockText('ceiling', t);
    return null;
}
