/**
 * The shapes the access model reads and the snapshot it answers from.
 *
 * Three server answers, three different questions (the web's studioApps.jsx
 * header names them), plus the person's own role:
 *
 *   GET /auth/my-entitlements  what this ORGANISATION's plan and grants let
 *                              this person use — capabilities, the plan
 *                              ceiling, and why a thing is locked
 *                              (server/auth/admin/featureAccessRoutes.js)
 *   GET /api/license/status    the INSTALLATION's licence: tier and features
 *                              (server/routes/license.js → getLicenseStatus)
 *   GET /auth/my-permissions   what this PERSON may do, per their org role
 *                              (server/auth/login/myPermissionsRoutes.js;
 *                              fetched once by core/auth, reused here)
 *   GET /auth/user             role, isAdmin, orgRole, Simple Mode, feature
 *                              flags (server/auth/login/currentUserRoutes.js)
 */

import type { FeatureFlags, OrgBrand } from '@/core/auth/types';

/** The capability buckets. MCP servers are integrations since the MCP bucket was folded in. */
export type CapabilityKind = 'core' | 'beta' | 'integration';

export type KindLists = Record<CapabilityKind, string[]>;

/** One row of the entitlements registry: enough to map a licence feature to its capability. */
export interface CapabilityRow {
    id: string;
    kind: string;
    /** The licence feature this capability is gated by, when it has one. */
    licenseFeature: string | null;
}

/** GET /auth/my-entitlements, as read. */
export interface Entitlements {
    mode: DeploymentMode;
    /** Normalised: a legacy 'pro' reads as 'enterprise'. */
    tier: string;
    superAdmin: boolean;
    /** The resolver could not answer; every list is empty and means nothing. */
    degraded: boolean;
    ceiling: KindLists;
    effective: KindLists;
    /** Capability id → why it is not effective ('not_granted' | 'ceiling' | …). */
    reasons: Record<string, string>;
    registry: CapabilityRow[];
}

/** GET /api/license/status, the part the gates read. */
export interface LicenseInfo {
    /** Normalised like Entitlements.tier. */
    tier: string;
    /** 'license_key' | 'stripe_subscription' | 'server_license' | 'default'. */
    source: string;
    /** The tier's features plus plan grants, as licence-feature names. */
    features: string[];
    /** A server-wide licence governs this installation (self-hosted). */
    serverOverride: boolean;
}

export type DeploymentMode = 'cloud' | 'self-hosted';

/**
 * Why a capability is not usable, as the web's EntitlementsContext.lockReason
 * answers it: 'not_granted' when the plan includes it but the organisation
 * has not switched it on (→ ask an admin), 'ceiling' when the plan does not
 * (→ upgrade). The server may name other reasons in `reasons`.
 */
export type LockReason = 'not_granted' | 'ceiling' | (string & {});

/**
 * Where one server answer stands. `unavailable` is a failed fetch OR a
 * degraded resolver: either way the lists say nothing, and nothing may be
 * shown as locked on the strength of them.
 */
export type SourceState = 'loading' | 'ready' | 'unavailable';

/** Entitlements with their lookups built once (see compileEntitlements). */
export interface CompiledEntitlements {
    data: Entitlements;
    /** Is the capability (or licence feature) in the effective set? */
    has: (id: string) => boolean;
    /** Is it within the plan ceiling? */
    inCeiling: (id: string) => boolean;
    /** A licence-feature name or capability id → the capability id. */
    resolveId: (id: string) => string;
}

/** Everything a gate is decided on, for one session at one moment. */
export interface AccessSnapshot {
    /** A user is present (signed in, locked or pending approval). */
    hasUser: boolean;
    userId: string | null;
    role: string;
    /** From /auth/user, else the copy /auth/my-permissions carries. */
    orgRole: string;
    organizationId: string | null;
    organization: OrgBrand | null;
    isSuperAdmin: boolean;
    isOrgAdmin: boolean;
    simpleMode: boolean;
    featureFlags: FeatureFlags;
    permissions: readonly string[];
    /** /auth/my-permissions has answered. */
    permissionsLoaded: boolean;
    betaFeatures: readonly string[];
    canUseFeature: Readonly<Record<string, boolean>>;
    entitlements: CompiledEntitlements | null;
    entitlementsState: SourceState;
    license: LicenseInfo | null;
    licenseState: SourceState;
    /** Entitlements' mode, else the /auth/user feature flag, else cloud. */
    mode: DeploymentMode;
    /** Entitlements' tier, else the licence tier, else community. */
    tier: string;
}
