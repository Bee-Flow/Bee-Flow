/**
 * The access snapshot and the questions asked of it. Pure: the hooks feed it
 * the four server answers, tests feed it fixtures.
 *
 * Loading is not refusal, and a failed answer is not "upgrade": until the
 * entitlements are real (`ready`), `lockReason` answers null, so nothing
 * flashes a lock on start-up or during a resolver outage — the web learned
 * this the hard way (Sidebar.jsx, the `lockReason` wrapper).
 */

import type { FeatureFlags, PermissionsResponse, User } from '@/core/auth/types';

import { lockReasonOf } from './entitlements';
import { canUseFeature, hasAnyPermission, hasPermission, isOrgAdmin, isSuperAdmin } from './roles';
import { normalizeTier, tierAtLeast } from './tiers';
import type {
    AccessSnapshot,
    CompiledEntitlements,
    DeploymentMode,
    LicenseInfo,
    LockReason,
    SourceState,
} from './types';

/** One server answer and where it stands. */
export interface Source<T> {
    state: SourceState;
    data: T | null;
}

export interface AccessInputs {
    /** The user of the current stage, if it has one. */
    user: User | null;
    permissions: PermissionsResponse | null;
    entitlements?: Source<CompiledEntitlements>;
    license?: Source<LicenseInfo>;
}

const LOADING: Source<never> = { state: 'loading', data: null };
const NO_FLAGS: FeatureFlags = {};
const NO_LIST: readonly string[] = [];
const NO_MAP: Readonly<Record<string, boolean>> = {};

function modeOf(entitlements: CompiledEntitlements | null, flags: FeatureFlags): DeploymentMode {
    if (entitlements) return entitlements.data.mode;
    return flags.deploymentMode === 'self-hosted' ? 'self-hosted' : 'cloud';
}

/** Only a ready answer counts (a degraded one arrives as unavailable); the rest says nothing. */
function usable<T>(source: Source<T>): T | null {
    return source.state === 'ready' ? source.data : null;
}

/** What /auth/user says about the person (none of it on a signed-out stage). */
function userFacts(user: User | null) {
    return {
        hasUser: Boolean(user),
        userId: user?.id ?? null,
        isAdmin: Boolean(user?.isAdmin),
        role: user?.role ?? '',
        orgRole: user?.orgRole ?? '',
        organizationId: user?.organizationId || null,
        organization: user?.organization ?? null,
        simpleMode: Boolean(user?.simpleMode),
        featureFlags: user?.featureFlags ?? NO_FLAGS,
    };
}

/** What /auth/my-permissions says; null (not answered, or failed) reads as nothing held. */
function permissionFacts(permissions: PermissionsResponse | null) {
    return {
        permissions: permissions?.permissions ?? NO_LIST,
        permissionsLoaded: permissions !== null,
        betaFeatures: permissions?.betaFeatures ?? NO_LIST,
        canUseFeature: permissions?.canUseFeature ?? NO_MAP,
        orgRole: permissions?.orgRole ?? '',
    };
}

export function buildAccessSnapshot({
    user,
    permissions,
    entitlements = LOADING,
    license = LOADING,
}: AccessInputs): AccessSnapshot {
    const { isAdmin, ...who } = userFacts(user);
    const { orgRole: grantedOrgRole, ...held } = permissionFacts(permissions);
    // A login answer carries no orgRole; my-permissions does.
    const person = { isAdmin, role: who.role, orgRole: who.orgRole || grantedOrgRole, permissions: held.permissions };
    const compiled = usable(entitlements);
    const licence = usable(license);
    return {
        ...who,
        ...held,
        orgRole: person.orgRole,
        isSuperAdmin: isSuperAdmin(person),
        isOrgAdmin: isOrgAdmin(person),
        entitlements: compiled,
        entitlementsState: entitlements.state,
        license: licence,
        licenseState: license.state,
        mode: modeOf(compiled, who.featureFlags),
        tier: normalizeTier(compiled?.data.tier ?? licence?.tier),
    };
}

/** EntitlementsContext.can: the capability (or licence feature) is effective. False until known. */
export function can(snapshot: AccessSnapshot, id: string): boolean {
    return snapshot.entitlements?.has(id) ?? false;
}

/** EntitlementsContext.inCeiling: the plan includes it, granted or not. */
export function inCeiling(snapshot: AccessSnapshot, id: string): boolean {
    return snapshot.entitlements?.inCeiling(id) ?? false;
}

/**
 * EntitlementsContext.lockReason, behind the Sidebar's guard: null when `id`
 * is usable AND while the answer is not real yet (loading, failed, degraded).
 */
export function lockReason(snapshot: AccessSnapshot, id: string): LockReason | null {
    return snapshot.entitlements ? lockReasonOf(snapshot.entitlements, id) : null;
}

/** Is the tier at least `required` (EntitlementsContext / LicenseContext hasTier)? */
export function hasTier(snapshot: AccessSnapshot, required: string): boolean {
    return tierAtLeast(snapshot.tier, required);
}

/**
 * LicenseContext.hasFeature. On the web it delegates to `can` — the licence
 * feature resolves to its capability, so a page cannot render while its API
 * 403s — and so does this. While the entitlements are UNAVAILABLE (a failed
 * fetch, a degraded resolver) the licence's own feature list answers instead:
 * what the licence middleware (requireLicenseFeature) enforces. Loading is
 * still no.
 */
export function hasLicenseFeature(snapshot: AccessSnapshot, id: string): boolean {
    if (snapshot.entitlements) return snapshot.entitlements.has(id);
    if (snapshot.entitlementsState !== 'unavailable') return false;
    return snapshot.license?.features.includes(id) ?? false;
}

/** The server's canUseFeature map, with the web's fallback (see roles.canUseFeature). */
export function canUse(snapshot: AccessSnapshot, id: string): boolean {
    return canUseFeature(snapshot, id);
}

/** The snapshot as roles.ts reads a person; its super-admin verdict is already made. */
function personOf(snapshot: AccessSnapshot) {
    return { isAdmin: snapshot.isSuperAdmin, permissions: snapshot.permissions };
}

/** Holds `id` or `all`, or is a super admin. */
export function holds(snapshot: AccessSnapshot, id: string): boolean {
    return hasPermission(personOf(snapshot), id);
}

/** Holds at least one of `ids`. */
export function holdsAny(snapshot: AccessSnapshot, ids: readonly string[]): boolean {
    return hasAnyPermission(personOf(snapshot), ids);
}

/** An installation feature flag; absent means on (the server writes `x !== false`). */
export function featureEnabled(snapshot: AccessSnapshot, flag: keyof FeatureFlags): boolean {
    return snapshot.featureFlags[flag] !== false;
}
