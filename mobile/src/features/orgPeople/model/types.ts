/**
 * The organisation's people, groups, roles, model tiers and feature grants,
 * as the route handlers send them. Each shape names the server file it was
 * read from; `api/contract.test.ts` pins the field names against that source.
 */

/**
 * `GET /auth/users` (auth/admin/userRoutes.js over stores/user/users.js
 * getAllUsers). `groups` is parsed server-side into an id list.
 */
export interface Member {
    id: string;
    username?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    role?: string;
    orgRole?: string;
    /** 'active' | 'pending' | …; absent on old rows, which count as active. */
    status?: string;
    organizationId?: string;
    avatar: string | null;
    avatarType: string | null;
    groups: string[];
    isSystem?: boolean;
    provider?: string;
    mfaEnabled?: boolean;
    lastSeenAt: string | null;
    createdAt?: string;
}

/** `GET /auth/groups` (auth/admin/groupRoleRoutes.js over stores/user/groups.js). */
export interface OrgGroup {
    id: string;
    name: string;
    description?: string;
    organizationId?: string;
    /** The org role every member inherits; '' or absent is "User (default)". */
    orgRole?: string;
    /** Empty = no restriction; otherwise only these tier ids. */
    allowedTiers: string[];
    /** 'manual', or where a synced group came from ('nextcloud', 'azure', …). */
    source?: string;
}

/** `GET /auth/invitations` (auth/admin/invitationRoutes.js, stores/invitationStore.js). */
export interface Invitation {
    id: string;
    email: string;
    role?: string;
    status?: string;
    inviterName?: string;
    created_at?: string;
    expires_at?: string;
}

/** `POST /auth/invitations` — `inviteUrl` is for sharing when the mail did not go out. */
export interface InviteResult {
    success: boolean;
    emailSent: boolean;
    inviteUrl: string | null;
}

/** `GET /auth/org-roles` — one role and what it resolves to for the caller's org. */
export interface OrgRolePermissions {
    id: string;
    permissions: string[];
}

export interface OrgRoles {
    roles: OrgRolePermissions[];
    /** Which permission ids `PUT /auth/org-roles/:roleId` will accept. */
    editablePermissions: string[];
}

/** `GET /ai/config/custom-tiers-list` — a custom tier's pill (routes/ai/config/modelTiers.js). */
export interface CustomTierMeta {
    id: string;
    label: string;
    icon?: string;
    description?: string;
    scope?: string;
}

/**
 * One organisation custom tier (normalizeCustomTier in modelTiers.js). The
 * reader keeps every other key the server stores (reasoningEffort, …): the
 * POST replaces the whole list, so a field this build does not know must
 * travel back untouched.
 */
export interface CustomTier {
    [key: string]: unknown;
    id: string;
    label: string;
    icon: string;
    description: string;
    modelId: string;
    euModelId: string;
    maxTokens: number;
    temperature: number;
    allowedTaskTypes: string[];
}

/** `GET /ai/config/org-custom-chat-models`. */
export interface OrgCustomTiers {
    orgTiers: CustomTier[];
    globalTiers: CustomTierMeta[];
}

/** `POST /ai/config/org-custom-chat-models` — the stored list and any model warnings. */
export interface SaveTiersResult {
    tiers: CustomTier[] | null;
    warnings: string[];
}

/** One model a tier may point at: `GET /ai/providers/:id/models`, tagged with its provider. */
export interface ModelOption {
    id: string;
    name: string;
    providerName: string;
}

export type CapabilityKind = 'core' | 'beta' | 'integration';

/** `GET /auth/organizations/:orgId/group-access` — buildGroupAccessResponse. */
export interface Capability {
    id: string;
    kind: string;
    name: string;
    description?: string;
    category?: string;
    lifecycle?: string;
}

export interface GroupGrants {
    id: string;
    name: string;
    granted: string[];
}

export interface GroupAccess {
    orgId: string | null;
    mode: string;
    capabilities: Capability[];
    /** The org's access menu: a capability outside it is locked. */
    ceiling: string[];
    /** Granted to all members. */
    everyone: string[];
    groups: GroupGrants[];
    /** Cloud: beta features follow the subscription, read-only here. */
    betaGoverned: boolean;
}
