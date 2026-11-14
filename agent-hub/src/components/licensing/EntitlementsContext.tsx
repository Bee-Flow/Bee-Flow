import React, { createContext, useContext, useCallback, useEffect, useMemo } from 'react';
import { errorMessage } from '../../utils/caughtError';
import { RefusedError } from '../../api/mutate';
import { useMyEntitlementsQuery } from '@/api/queries/myEntitlements';

interface CapabilitySets {
    core: string[];
    beta: string[];
    integration: string[];
    mcp?: string[];
}

interface CapabilityRegistryEntry {
    id: string;
    licenseFeature?: string;
    [key: string]: unknown;
}

interface EntitlementsState {
    loading: boolean;
    degraded: boolean;
    tier: string;
    mode: string;
    superAdmin: boolean;
    effective: CapabilitySets;
    ceiling: CapabilitySets;
    reasons: Record<string, string>;
    registry: CapabilityRegistryEntry[];
    error: string | null | undefined;
}

export interface EntitlementsValue {
    loading: boolean;
    degraded: boolean;
    tier: string;
    mode: string;
    superAdmin?: boolean;
    effective: CapabilitySets;
    ceiling: CapabilitySets;
    registry?: CapabilityRegistryEntry[];
    error?: string | null;
    can: (id: string) => boolean;
    inCeiling: (id: string) => boolean;
    lockReason: (id: string) => string | null;
    hasTier: (req: string) => boolean;
    reload: () => void;
}

/**
 * EntitlementsContext — the single client-side source for "what can this user
 * use". Fetches GET /auth/my-entitlements (the unified resolver snapshot) and
 * exposes a flat `can(id)` plus the kind-keyed `effective`/`ceiling` sets and
 * the deployment mode. Supersedes the data sources of LicenseContext +
 * SubscriptionContext + FeatureGate; those remain as thin consumers during the
 * cut-over. Authoritative gating stays server-side — this is display-only.
 */

const TIER_RANK: Record<string, number> = { community: 0, enterprise: 1, full: 2 };
const LEGACY_TIER_ALIAS: Record<string, string> = { pro: 'enterprise' };
const normalizeTier = (t: string) => LEGACY_TIER_ALIAS[t] || t || 'community';

// MCP servers are integrations now — no separate `mcp` bucket.
const EMPTY: CapabilitySets = { core: [], beta: [], integration: [] };

const EntitlementsContext = createContext<EntitlementsValue>({
    loading: true,
    degraded: false,
    tier: 'community',
    mode: 'cloud',
    effective: EMPTY,
    ceiling: EMPTY,
    can: () => false,
    inCeiling: () => false,
    lockReason: () => null,
    hasTier: () => false,
    reload: () => {},
});

interface EntitlementsProviderProps {
    children?: React.ReactNode;
}

/** The snapshot as the server sends it. */
interface EntitlementsAnswer {
    degraded?: boolean;
    tier: string;
    mode?: string;
    superAdmin?: boolean;
    effective?: CapabilitySets;
    ceiling?: CapabilitySets;
    reasons?: Record<string, string>;
    registry?: unknown;
}

const INITIAL: EntitlementsState = {
    loading: true,
    degraded: false,
    tier: 'community',
    mode: 'cloud',
    superAdmin: false,
    effective: EMPTY,
    ceiling: EMPTY,
    reasons: {},
    registry: [],
    error: null,
};

/** The provider's state: the last snapshot, loading until the first answer, the last read's error. */
function stateOf(j: EntitlementsAnswer | undefined, error: Error | null, answered: boolean): EntitlementsState {
    const base: EntitlementsState = j ? {
        loading: false,
        degraded: !!j.degraded,
        tier: normalizeTier(j.tier),
        mode: j.mode === 'self-hosted' ? 'self-hosted' : 'cloud',
        superAdmin: !!j.superAdmin,
        effective: j.effective || EMPTY,
        ceiling: j.ceiling || EMPTY,
        reasons: j.reasons || {},
        registry: Array.isArray(j.registry) ? j.registry as CapabilityRegistryEntry[] : [],
        error: null,
    } : INITIAL;
    if (!error) return answered ? { ...base, loading: false } : base;
    return { ...base, loading: false, error: error instanceof RefusedError ? `HTTP ${error.status}` : errorMessage(error) };
}

export function EntitlementsProvider({ children }: EntitlementsProviderProps) {
    const query = useMyEntitlementsQuery<EntitlementsAnswer>();
    const { refetch } = query;
    const answered = query.isSuccess || query.isError;
    const state = useMemo(() => stateOf(query.data, query.error, answered), [query.data, query.error, answered]);
    const reload = useCallback(async () => { await refetch(); }, [refetch]);

    // Read on mount, and AGAIN whenever auth state flips. This provider is
    // mounted above the auth boundary (so LicenseContext.hasFeature can delegate
    // to it), so its first read can run pre-login (401 → empty effective). App
    // dispatches `beeflow:auth-changed` on login/logout/bootstrap so we re-resolve
    // with the real session — otherwise the empty pre-login snapshot would persist
    // and hide every capability-gated surface after login.
    useEffect(() => {
        const onAuthChanged = () => { void refetch(); };
        window.addEventListener('beeflow:auth-changed', onAuthChanged);
        return () => window.removeEventListener('beeflow:auth-changed', onAuthChanged);
    }, [refetch]);

    const value = useMemo(() => {
        // Defensive: fold any legacy `mcp` bucket (older backend payload) into
        // integration so frontend/backend deploy order can't break gating.
        const effSets = {
            core: new Set(state.effective.core || []),
            beta: new Set(state.effective.beta || []),
            integration: new Set([...(state.effective.integration || []), ...(state.effective.mcp || [])]),
        };
        const ceilSets = {
            core: new Set(state.ceiling.core || []),
            beta: new Set(state.ceiling.beta || []),
            integration: new Set([...(state.ceiling.integration || []), ...(state.ceiling.mcp || [])]),
        };
        // Accept either a capability id OR a legacy licence-feature name: map
        // licence-feature → capability id so every hasFeature('X')/can('X') call
        // site resolves to the same effective set the server's requireCapability
        // uses, regardless of which namespace the caller passes.
        const featureToCapId: Record<string, string> = {};
        for (const c of (state.registry || [])) {
            if (!c || !c.id) continue;
            featureToCapId[c.id] = c.id;
            if (c.licenseFeature && !(c.licenseFeature in featureToCapId)) featureToCapId[c.licenseFeature] = c.id;
        }
        const resolveId = (id: string) => featureToCapId[id] || id;
        const has = (set: Record<string, Set<string>>, id: string) => { const cid = resolveId(id); return set.core.has(cid) || set.beta.has(cid) || set.integration.has(cid); };
        return {
            loading: state.loading,
            degraded: !!state.degraded,
            tier: state.tier,
            mode: state.mode,
            superAdmin: state.superAdmin,
            effective: state.effective,
            ceiling: state.ceiling,
            registry: state.registry,
            error: state.error,
            can: (id: string) => has(effSets, id),
            inCeiling: (id: string) => has(ceilSets, id),
            lockReason: (id: string) => (has(effSets, id) ? null : (has(ceilSets, id) ? 'not_granted' : (state.reasons[resolveId(id)] || 'ceiling'))),
            hasTier: (req: string) => (TIER_RANK[state.tier] ?? -1) >= (TIER_RANK[normalizeTier(req)] ?? 99),
            reload,
        };
    }, [state, reload]);

    return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>;
}

export function useEntitlements() {
    return useContext(EntitlementsContext);
}

export default EntitlementsContext;
