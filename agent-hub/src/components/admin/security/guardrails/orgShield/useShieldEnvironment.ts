import { useEffect, useEffectEvent, useState } from 'react';
import { API_BASE } from '../../../../../utils/helpers';
import { settled } from '../../../../../api/settled';
import { logger } from '../../../../../utils/logger';

export interface ShieldOrg {
    id: string;
    name?: string;
    [key: string]: unknown;
}

/** Is the PII Guard installed and answering? */
export interface GuardStatus {
    configured: boolean;
    reachable: boolean;
}

export interface ShieldEnvironment {
    /** True until the mount-time reads have finished. */
    loading: boolean;
    orgList: ShieldOrg[];
    hasEuModelsConfigured: boolean;
    hasWebSearchEnabled: boolean;
    /** null = not heard back yet, which is NOT "healthy": nothing renders a claim until it answers. */
    guardStatus: GuardStatus | null;
    /** When that answer arrived (ms); the probe is not repeated. */
    guardCheckedAt: number | null;
}

/** Whether any EU tier has a model set. */
function hasAnyEuModel(euModels: Record<string, { modelId?: string } | null>): boolean {
    return Object.values(euModels).some(tier => tier && tier.modelId && tier.modelId.trim() !== '');
}

/**
 * Mount: the environment flags that decide which cards are relevant at all,
 * the PII Guard's status and the org list. `onOrgs` receives the list once it
 * lands (the caller decides whether it may pick one).
 *
 * The guard status is the dependency this screen never admitted to. With the
 * sidecar missing or down, category detection does not run at all — so every
 * category tick, both sensitivity presets and both tool lists on this page are
 * decoration. (Custom terms and patterns keep working; they need no model.)
 * `derivePosture` has a `guard` row; this is its feed.
 */
export default function useShieldEnvironment(onOrgs: (orgs: ShieldOrg[]) => void): ShieldEnvironment {
    const [loading, setLoading] = useState(true);
    const [orgList, setOrgList] = useState<ShieldOrg[]>([]);
    const [hasEuModelsConfigured, setHasEuModelsConfigured] = useState(false);
    const [hasWebSearchEnabled, setHasWebSearchEnabled] = useState(false);
    const [guardStatus, setGuardStatus] = useState<GuardStatus | null>(null);
    const [guardCheckedAt, setGuardCheckedAt] = useState<number | null>(null);
    const deliverOrgs = useEffectEvent((orgs: ShieldOrg[]) => onOrgs(orgs));

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await settled(`${API_BASE}/ai/config`, undefined, 'empty');
                if (res.ok && !cancelled) {
                    const data = await res.res.json();
                    setHasWebSearchEnabled(!!(data.searchProvider && data.searchProvider !== 'disabled'));
                }

                const euRes = await settled(`${API_BASE}/ai/config/chat-models-eu`, undefined, 'empty');
                if (euRes.ok && !cancelled) {
                    setHasEuModelsConfigured(hasAnyEuModel(await euRes.res.json()));
                }

                // Self-scoped and cheap (the route memoises its health probe
                // for 15s). A failure here leaves the status `null`, which
                // renders nothing — an unreachable *status endpoint* is not
                // evidence of an unreachable guard.
                try {
                    const guardRes = await settled(`${API_BASE}/api/org-privacy-shield/user/guard-status`, undefined, 'empty');
                    if (guardRes.ok && !cancelled) {
                        const status = await guardRes.res.json();
                        setGuardStatus({
                            configured: status.configured !== false,
                            reachable: status.reachable !== false,
                        });
                        setGuardCheckedAt(Date.now());
                    }
                } catch (err) { logger.debug('stays null — see above', err); }

                const orgRes = await settled(`${API_BASE}/auth/organizations`, undefined, 'empty');
                if (orgRes.ok && !cancelled) {
                    const orgs = await orgRes.res.json();
                    setOrgList(orgs);
                    deliverOrgs(orgs);
                }
            } catch (e) {
                console.error('[OrgShield] Failed to fetch config', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    return { loading, orgList, hasEuModelsConfigured, hasWebSearchEnabled, guardStatus, guardCheckedAt };
}
