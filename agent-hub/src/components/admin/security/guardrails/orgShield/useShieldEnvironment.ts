import { useEffect, useEffectEvent, useState } from 'react';
import { API_BASE, authFetch } from '../../../../../utils/helpers';

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
                const res = await authFetch(`${API_BASE}/ai/config`);
                if (res.ok && !cancelled) {
                    const data = await res.json();
                    setHasWebSearchEnabled(!!(data.searchProvider && data.searchProvider !== 'disabled'));
                }

                const euRes = await authFetch(`${API_BASE}/ai/config/chat-models-eu`);
                if (euRes.ok && !cancelled) {
                    setHasEuModelsConfigured(hasAnyEuModel(await euRes.json()));
                }

                // Self-scoped and cheap (the route memoises its health probe
                // for 15s). A failure here leaves the status `null`, which
                // renders nothing — an unreachable *status endpoint* is not
                // evidence of an unreachable guard.
                try {
                    const guardRes = await authFetch(`${API_BASE}/api/org-privacy-shield/user/guard-status`);
                    if (guardRes.ok && !cancelled) {
                        const status = await guardRes.json();
                        setGuardStatus({
                            configured: status.configured !== false,
                            reachable: status.reachable !== false,
                        });
                        setGuardCheckedAt(Date.now());
                    }
                } catch { /* stays null — see above */ }

                const orgRes = await authFetch(`${API_BASE}/auth/organizations`);
                if (orgRes.ok && !cancelled) {
                    const orgs = await orgRes.json();
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
