import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSetupStatusQuery } from '@/api/queries/loginReads';
import { licenseStatusKey, useLicenseStatusQuery } from '@/api/queries/licenseStatus';
import { useEntitlements } from './EntitlementsContext';
import UpgradePrompt from '../billing/UpgradePrompt';
import { messageOf } from '../../utils/caughtError';
import { normalizeTier, TIER_RANK } from './licenseTiers';
import { apiFetch } from '@/api/typedRequest';

/** A licence or subscription row as /api/license/status returns it. */
interface LicenseRecord {
    tier?: string;
    expiresAt?: string | null;
    issuer?: string;
    billingInterval?: string;
}

interface LicenseState {
    tier: string;
    source: string;
    scope: string | null;
    license: LicenseRecord | null;
    subscription: LicenseRecord | null;
    features: string[];
    limits: Record<string, number>;
    serverOverride: boolean;
    serverLicense: LicenseRecord | null;
    upgradeUrl: string;
    deploymentMode: string;
    loading: boolean;
    error: string | null;
}

interface LicenseContextValue extends LicenseState {
    hasFeature: (name: string) => boolean;
    hasTier: (required: string) => boolean;
    entLoading?: boolean;
    entDegraded?: boolean;
    entError?: string | null;
    reload: () => Promise<void>;
    activate: (token: string) => Promise<unknown>;
    deactivate: () => Promise<void>;
    refresh: () => Promise<unknown>;
}

interface LicenseActionResponse {
    code?: string;
    error?: string;
    status?: Partial<LicenseState>;
}

type NavigateToBilling = (arg: { feature: string | null; requiredTier: string }) => void;

/**
 * LicenseContext — app-wide tier/feature awareness.
 *
 * Wrap the authenticated portion of the app with <LicenseProvider> so any
 * component can call useLicenseContext() without re-fetching status.
 *
 * The provider polls /api/license/status once on mount and exposes
 * reload/activate/deactivate/refresh. There used to be a separate
 * useLicense() hook that fired a second status request and held its own
 * copy of state — those two copies could drift on activation. The hook is
 * gone; the provider is the single source of truth.
 */

const LicenseContext = createContext<LicenseContextValue>({
    tier: 'community',
    source: 'default',
    scope: null,
    license: null,
    subscription: null,
    features: [],
    limits: {},
    // serverOverride: true when a server-wide licence is GOVERNING this
    // install (self-hosted). Per-org activation UI uses it to
    // switch into a read-only banner ("Tier is managed server-wide"). It is
    // false on cloud even when a server licence exists. See
    // server/license/index.js → getLicenseStatus / serverLicenseGovernsOrgs.
    serverOverride: false,
    // serverLicense: the server-wide licence row (public shape) when one
    // exists, regardless of deployment mode — admin Server-licence panel uses
    // it to display/manage the licence even on cloud (where it doesn't govern).
    serverLicense: null,
    upgradeUrl: 'https://beeflow.nl/pricing',
    // 'cloud' (Bee Flow SaaS) or 'self-hosted' (customer-run install). Drives
    // which paid-access mechanism is shown: subscriptions on cloud, license
    // keys on self-hosted. Sourced from /auth/setup-status (server env
    // DEPLOYMENT_MODE). Defaults to 'cloud' until setup-status resolves.
    deploymentMode: 'cloud',
    loading: true,
    error: null,
    hasFeature: () => false,
    hasTier: () => false,
    reload: async () => {},
    activate: async () => {},
    deactivate: async () => {},
    refresh: async () => {},
});

const INITIAL_STATE: LicenseState = {
    tier: 'community',
    source: 'default',
    scope: null,
    license: null,
    subscription: null,
    features: [],
    limits: {},
    serverOverride: false,
    serverLicense: null,
    loading: true,
    error: null,
    upgradeUrl: 'https://beeflow.nl/pricing',
    deploymentMode: 'cloud',
};

interface LicenseStatusAnswer extends Partial<LicenseState> {
    tier: string;
}

interface SetupStatusAnswer {
    licenseUpgradeUrl?: string;
    deploymentMode?: string;
}

/**
 * Older deployments may still respond with `tier: 'pro'` from legacy license
 * rows; normalise so paywall UI matches the current hierarchy.
 */
function normalisedStatus(data: LicenseStatusAnswer): Partial<LicenseState> {
    const normalised: Partial<LicenseState> = { ...data, tier: normalizeTier(data.tier) };
    if (data.license && typeof data.license === 'object') {
        normalised.license = { ...data.license, tier: normalizeTier(data.license.tier || '') };
    }
    if (data.subscription && typeof data.subscription === 'object') {
        normalised.subscription = { ...data.subscription, tier: normalizeTier(data.subscription.tier || '') };
    }
    return normalised;
}

/** The (self-host-overridable) upgrade URL and the deployment mode, when setup-status names them. */
function setupPatch(data: SetupStatusAnswer | null | undefined): Partial<LicenseState> {
    const patch: Partial<LicenseState> = {};
    if (data?.licenseUpgradeUrl) patch.upgradeUrl = data.licenseUpgradeUrl;
    if (data?.deploymentMode === 'cloud' || data?.deploymentMode === 'self-hosted') patch.deploymentMode = data.deploymentMode;
    return patch;
}

/**
 * The licence status (on mount AND again whenever auth flips) and the upgrade
 * URL from /auth/setup-status (once). This provider is mounted above the auth
 * boundary, so its first read runs pre-login (anonymous → community/default
 * snapshot). App dispatches `beeflow:auth-changed` on login/logout/bootstrap;
 * without re-resolving here, the pre-login tier/features/limits would persist
 * after login and every tier- or licence-gated surface would stay stale until a
 * full page refresh. Mirrors EntitlementsContext, which delegates `hasFeature` here.
 */
function useLicenseState() {
    const status = useLicenseStatusQuery<LicenseStatusAnswer>();
    // Falls back to the public BeeFlow pricing page if the server does not
    // surface a URL (e.g. older API versions).
    const setup = useSetupStatusQuery<SetupStatusAnswer>();
    const { refetch } = status;
    const reload = useCallback(async () => { await refetch(); }, [refetch]);

    useEffect(() => {
        if (status.error) console.warn('[LicenseProvider] reload failed', status.error);
    }, [status.error]);
    useEffect(() => {
        const onAuthChanged = () => { void refetch(); };
        window.addEventListener('beeflow:auth-changed', onAuthChanged);
        return () => window.removeEventListener('beeflow:auth-changed', onAuthChanged);
    }, [refetch]);

    const state = useMemo<LicenseState>(() => ({
        ...INITIAL_STATE,
        ...setupPatch(setup.data),
        ...(status.data ? normalisedStatus(status.data) : {}),
        loading: status.isPending,
        error: status.error ? messageOf(status.error, 'license fetch failed') : null,
    }), [setup.data, status.data, status.isPending, status.error]);
    return { state, reload };
}

export function LicenseProvider({ children }: { children: React.ReactNode }) {
    const qc = useQueryClient();
    const { state, reload } = useLicenseState();

    const activate = useCallback(async (token: string) => {
        const r = await apiFetch('POST /api/license/activate', { body: { token } });
        let data: LicenseActionResponse = {};
        try { data = await r.json(); } catch (e) { console.warn('[LicenseProvider] activate response not JSON', e); }
        if (!r.ok) {
            const err: Error & { code?: string } = new Error(data.error || `HTTP ${r.status}`);
            err.code = data.code;
            throw err;
        }
        if (data.status) {
            const shown = data.status;
            qc.setQueryData<LicenseStatusAnswer>(licenseStatusKey, (prev) => ({ ...(prev ?? { tier: 'community' }), ...shown } as LicenseStatusAnswer));
        }
        await reload();
        return data;
    }, [reload, qc]);

    const deactivate = useCallback(async () => {
        const r = await apiFetch('DELETE /api/license/deactivate');
        if (!r.ok && r.status !== 404) {
            let data: LicenseActionResponse = {};
            try { data = await r.json(); } catch (e) { console.warn('[LicenseProvider] deactivate response not JSON', e); }
            throw new Error(data.error || `HTTP ${r.status}`);
        }
        await reload();
    }, [reload]);

    const refresh = useCallback(async () => {
        const r = await apiFetch('POST /api/license/refresh');
        let data: LicenseActionResponse = {};
        try { data = await r.json(); } catch (e) { console.warn('[LicenseProvider] refresh response not JSON', e); }
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await reload();
        return data;
    }, [reload]);

    const tier = state.tier;
    // Feature gating delegates to the unified entitlements snapshot — the SAME
    // resolver the server's requireCapability enforces — so a page can never
    // render while its API 403s. `ent.can` accepts capability ids AND legacy
    // licence-feature names (see EntitlementsContext). The `state.features`
    // array from /api/license/status is still fetched for licence-management
    // display, but no longer drives gating. `hasTier` stays on the licence tier
    // (a licence-management concern, not a per-capability grant).
    const ent = useEntitlements();
    const entCan = ent.can;
    const hasFeature = useCallback((name: string) => entCan(name), [entCan]);
    const hasTier = useCallback(
        (required: string) => {
            const a = TIER_RANK[normalizeTier(tier)] ?? -1;
            const b = TIER_RANK[normalizeTier(required)] ?? 99;
            return a >= b;
        },
        [tier],
    );

    const value = useMemo(() => ({
        ...state,
        hasFeature,
        hasTier,
        // Surface entitlements load/degraded/error so feature gates can avoid a
        // render-then-flip while the snapshot resolves, and fail OPEN on a
        // transient resolver outage (the server gate stays authoritative).
        entLoading: ent.loading,
        entDegraded: ent.degraded,
        entError: ent.error,
        reload,
        activate,
        deactivate,
        refresh,
    }), [state, hasFeature, hasTier, ent.loading, ent.degraded, ent.error, reload, activate, deactivate, refresh]);

    return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

export function useLicenseContext() {
    return useContext(LicenseContext);
}

/**
 * <RequireTier tier="enterprise">...</RequireTier> — render children only when
 * the active tier is at least the given level. Otherwise render an upgrade
 * panel.
 *
 * Use sparingly — for hard route gating. Most UI elements should soft-gate
 * via lock icons (see <LockedIfBelow />).
 */
export function RequireTier({
    tier = 'enterprise', feature = null, children, fallback = null,
    onNavigateToLicense = null, onNavigateToBilling = null,
}: {
    tier?: string;
    feature?: string | null;
    children?: React.ReactNode;
    fallback?: React.ReactNode;
    onNavigateToLicense?: (() => void) | null;
    onNavigateToBilling?: NavigateToBilling | null;
}) {
    const ctx = useLicenseContext();
    const upgradeUrl = ctx.upgradeUrl || 'https://beeflow.nl/pricing';
    // Wait for the licence status and, for a feature gate, the entitlements
    // snapshot before deciding — prevents a flash of the upgrade panel.
    if (ctx.loading || (feature && ctx.entLoading)) return null;

    // Feature gates fail OPEN on a transient resolver outage (degraded / fetch
    // error): render the page and let the server gate enforce, rather than show
    // a false "upgrade" wall during a backend blip. Tier gates are unaffected.
    const entUnavailable = !!(ctx.entDegraded || ctx.entError);
    const ok = feature ? (entUnavailable || ctx.hasFeature(feature)) : ctx.hasTier(tier);
    if (ok) return <>{children}</>;
    if (fallback) return fallback;

    return (
        <UpgradePrompt
            requiredTier={tier}
            feature={feature}
            deploymentMode={ctx.deploymentMode}
            upgradeUrl={upgradeUrl}
            onNavigateToBilling={onNavigateToBilling}
            onNavigateToLicense={onNavigateToLicense}
        />
    );
}

/**
 * <LockedIfBelow tier="enterprise">{({ locked, requiredTier }) => (...)}</LockedIfBelow>
 * Render-prop helper for lightweight inline gating (lock icons, tooltips).
 */
function LockedIfBelow({ tier = 'enterprise', feature = null, children }: {
    tier?: string;
    feature?: string | null;
    children: (arg: { locked: boolean; requiredTier: string; currentTier: string; ctx: LicenseContextValue }) => React.ReactNode;
}) {
    const ctx = useLicenseContext();
    // Don't flash a lock while the snapshot is still loading, and don't show a
    // false lock during a transient resolver outage — fail open (server gate
    // remains authoritative).
    const entUnavailable = !!(ctx.entLoading || ctx.entDegraded || ctx.entError);
    const ok = feature ? (entUnavailable || ctx.hasFeature(feature)) : ctx.hasTier(tier);
    return children({ locked: !ok, requiredTier: tier, currentTier: ctx.tier, ctx });
}

export default LicenseContext;
