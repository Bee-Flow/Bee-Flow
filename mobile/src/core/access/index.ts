/**
 * What may this session be OFFERED? The phone's port of the web's three gates
 * — licence (LicenseContext), entitlements (EntitlementsContext) and
 * permissions — plus the admin roles, as hooks for screens and pure functions
 * for lists that gate many rows against one snapshot.
 */

export {
    useAccess,
    useCan,
    useCanUse,
    useGate,
    useHasAnyPermission,
    useHasLicenseFeature,
    useHasPermission,
    useIsOrgAdmin,
    useIsSuperAdmin,
} from './hooks';
export { accessKeys } from './keys';
export { evaluateGate } from './model/gate';
export type { Gate, GateReason, GateResult, HideReason } from './model/gate';
export { lockHint } from './model/lockHint';
export { ORG_ADMIN_ROLES, isOrgAdmin, isSuperAdmin } from './model/roles';
export {
    buildAccessSnapshot,
    can,
    canUse,
    featureEnabled,
    hasLicenseFeature,
    hasTier,
    holds,
    holdsAny,
    inCeiling,
    lockReason,
} from './model/snapshot';
export type { AccessInputs, Source } from './model/snapshot';
export { normalizeTier, tierAtLeast, TIER_HIERARCHY } from './model/tiers';
export type {
    AccessSnapshot,
    CompiledEntitlements,
    DeploymentMode,
    Entitlements,
    LicenseInfo,
    LockReason,
    SourceState,
} from './model/types';
