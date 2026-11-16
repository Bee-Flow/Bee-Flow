// The licence tier the dashboard's gates read (the tabs, useAdminTabAccess, and
// the rail's tier-gated child rows, adminRailRows). LicenseContext reads the tier
// as Community until /api/license/status answers, and again when that read fails
// (a 429 on a fast reload, a dropped connection), so a tier-gated rail row such
// as Agents would vanish and the rows under it shift up. Here an unanswered or
// failed read keeps the last answer this browser tab had (sessionStorage, so it
// also carries over a full reload). A failed read with no answer to fall back on
// reads as the context says (Community), as before: minTier is the only licence
// gate some paid surfaces have (Appearance's routes carry no tier gate), so an
// unknown tier never opens them, and with nothing remembered no row was shown
// that could vanish. Only a first read still out with nothing remembered waits
// (`pending`), as before.
//
// The memory belongs to one signed-in person: it names the user it was written
// for (scopedStorage's current user) and reads as nothing for anyone else, and
// logout drops it (forgetLicenceTier, from hooks/sessionCaches), because logout
// does not reload the page and the next person signs in in the same tab.

import { useEffect } from 'react';
import { useLicenseContext } from '@/components/licensing/LicenseContext';
import { normalizeTier, TIER_RANK } from '@/components/licensing/licenseTiers';
import { logger } from '@/utils/logger';
import { getCurrentUser } from '@/utils/scopedStorage';

const MEMORY_KEY = 'beeflow.admin.licenceTier';

export interface SteadyLicenceTier {
    /** The tier the gates read, normalised. */
    tier: string;
    hasTier: (required: string) => boolean;
    /** A first read is still out and nothing is remembered: a refused tier-gated tab may still open. */
    pending: boolean;
}

/** The remembered tier, when it was written for the person signed in now. */
function rememberedTier(): string | null {
    const user = getCurrentUser();
    if (!user) return null;
    try {
        const saved: unknown = JSON.parse(window.sessionStorage.getItem(MEMORY_KEY) || 'null');
        if (!saved || typeof saved !== 'object') return null;
        const { user: owner, tier } = saved as { user?: unknown; tier?: unknown };
        return owner === user && typeof tier === 'string' && Object.hasOwn(TIER_RANK, tier) ? tier : null;
    } catch (err) {
        logger.debug('[admin] licence tier memory unreadable (storage blocked or malformed); nothing remembered', err);
        return null;
    }
}

function rememberTier(tier: string): void {
    const user = getCurrentUser();
    if (!user) return;
    try {
        window.sessionStorage.setItem(MEMORY_KEY, JSON.stringify({ user, tier }));
    } catch (err) {
        logger.debug('[admin] licence tier memory not saved (storage blocked); a reload has nothing to fall back on', err);
    }
}

/** Drops the remembered tier; called on logout (hooks/sessionCaches.clearSessionCaches). */
export function forgetLicenceTier(): void {
    try {
        window.sessionStorage.removeItem(MEMORY_KEY);
    } catch (err) {
        logger.debug('[admin] licence tier memory not cleared (storage blocked)', err);
    }
}

const reaches = (tier: string) => (required: string) => (TIER_RANK[tier] ?? -1) >= (TIER_RANK[normalizeTier(required)] ?? Infinity);

/** The licence tier for the dashboard's gates, steady across a read that is out or failed. */
export function useSteadyLicenceTier(): SteadyLicenceTier {
    const { tier, hasTier, loading, error } = useLicenseContext();
    const answered = !loading && !error;
    useEffect(() => {
        if (answered) rememberTier(normalizeTier(tier));
    }, [answered, tier]);
    if (answered) return { tier, hasTier: (required) => !!hasTier(required), pending: false };
    const remembered = rememberedTier();
    if (remembered) return { tier: remembered, hasTier: reaches(remembered), pending: false };
    return { tier, hasTier: (required) => !!hasTier(required), pending: !error };
}
