import { useEffect, useEffectEvent } from 'react';
import {
    useShieldAiConfigQuery, useShieldEuModelsQuery, useShieldGuardStatusQuery, useShieldOrganizationsQuery,
} from '@/api/queries/shellReads';

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
const NO_ORGS: ShieldOrg[] = [];

export default function useShieldEnvironment(onOrgs: (orgs: ShieldOrg[]) => void): ShieldEnvironment {
    const aiConfig = useShieldAiConfigQuery<{ searchProvider?: string }>();
    const euModels = useShieldEuModelsQuery<Record<string, { modelId?: string } | null>>();
    const guard = useShieldGuardStatusQuery<{ configured?: boolean; reachable?: boolean }>();
    const orgs = useShieldOrganizationsQuery<ShieldOrg>();
    const orgList = orgs.data ?? NO_ORGS;

    // The caller decides whether it may pick one of the orgs once they land.
    const deliverOrgs = useEffectEvent((list: ShieldOrg[]) => onOrgs(list));
    const landedOrgs = orgs.data;
    useEffect(() => { if (landedOrgs) deliverOrgs(landedOrgs); }, [landedOrgs]);

    const status = guard.data;
    return {
        loading: [aiConfig, euModels, guard, orgs].some(q => q.isPending),
        orgList,
        hasEuModelsConfigured: !!euModels.data && hasAnyEuModel(euModels.data),
        hasWebSearchEnabled: !!(aiConfig.data?.searchProvider && aiConfig.data.searchProvider !== 'disabled'),
        // A failure leaves the status null, which renders nothing: an unreachable
        // status endpoint is not evidence of an unreachable guard.
        guardStatus: status ? { configured: status.configured !== false, reachable: status.reachable !== false } : null,
        guardCheckedAt: status ? guard.dataUpdatedAt : null,
    };
}
