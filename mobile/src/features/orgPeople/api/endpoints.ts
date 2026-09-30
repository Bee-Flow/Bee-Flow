/**
 * The organisation's people, groups, roles, model tiers and feature grants.
 *
 * Verified against (method, body, answer, guard):
 *   - server/auth/admin/userRoutes.js — GET /auth/users; PUT /auth/users/:id
 *     (refuses any key outside USER_UPDATE_ALLOWED_KEYS, 409
 *     `confirm_self_demotion` without `confirmSelfDemotion: true`);
 *     POST /auth/users/:id/mfa/reset; DELETE /auth/users/:id.
 *   - server/auth/admin/invitationRoutes.js — GET/POST /auth/invitations
 *     (`{ email, role? }`, strict; 20 per hour per inviter → 429),
 *     DELETE /auth/invitations/:id.
 *   - server/auth/admin/groupRoleRoutes.js — GET/POST /auth/groups
 *     (CreateGroupBody, strict), PUT/DELETE /auth/groups/:id (UpdateGroupBody,
 *     strict, a patch: absent keys are left alone), POST/DELETE
 *     /auth/groups/:id/members[/:userId], GET /auth/org-roles,
 *     PUT /auth/org-roles/:roleId (`{ permissions }`, the full editable set).
 *   - server/routes/ai/config/modelTiers.js — GET /ai/config/custom-tiers-list,
 *     GET/POST /ai/config/org-custom-chat-models (`{ tiers }` replaces the list).
 *   - server/routes/ai/providers.js — GET /ai/providers, /ai/providers/:id/models.
 *   - server/auth/admin/featureAccessRoutes.js — GET
 *     /auth/organizations/:orgId/group-access, PUT …/org-access and
 *     PUT /auth/groups/:id/access (`{ granted }`, strict; each REPLACES that
 *     scope's grants across every kind, clamped to the org's access menu).
 */

import { api } from '@/core/api/client';
import { optional } from '@/core/api/optional';

import {
    readCustomTiersList,
    readGroupAccess,
    readGroups,
    readInvitations,
    readInviteResult,
    readMembers,
    readMfaReset,
    readModels,
    readOrgCustomTiers,
    readOrgRoles,
    readProviders,
    readSavedRolePermissions,
    readSaveTiersResult,
} from './readers';
import type {
    CustomTier,
    CustomTierMeta,
    GroupAccess,
    Invitation,
    InviteResult,
    Member,
    ModelOption,
    OrgCustomTiers,
    OrgGroup,
    OrgRoles,
    SaveTiersResult,
} from '../model/types';

const seg = (id: string) => encodeURIComponent(id);

// ── Members ────────────────────────────────────────────────────────────

export async function listMembers(signal?: AbortSignal): Promise<Member[]> {
    return readMembers(await api.get<unknown>('/auth/users', { signal }));
}

/** Only keys the server's allow-list takes; anything else is a 400. */
export interface MemberPatch {
    orgRole?: string;
    status?: string;
    groups?: string[];
    confirmSelfDemotion?: true;
}

export async function updateMember(id: string, patch: MemberPatch): Promise<void> {
    await api.put(`/auth/users/${seg(id)}`, patch);
}

export async function deleteMember(id: string): Promise<void> {
    await api.delete(`/auth/users/${seg(id)}`);
}

export async function resetMemberMfa(id: string): Promise<{ wasEnabled: boolean }> {
    return readMfaReset(await api.post<unknown>(`/auth/users/${seg(id)}/mfa/reset`));
}

// ── Invitations ────────────────────────────────────────────────────────

export async function listInvitations(signal?: AbortSignal): Promise<Invitation[]> {
    return readInvitations(await api.get<unknown>('/auth/invitations', { signal }));
}

export async function createInvitation(body: { email: string; role?: string }): Promise<InviteResult> {
    return readInviteResult(await api.post<unknown>('/auth/invitations', body));
}

export async function revokeInvitation(id: string): Promise<void> {
    await api.delete(`/auth/invitations/${seg(id)}`);
}

// ── Groups ─────────────────────────────────────────────────────────────

export async function listGroups(signal?: AbortSignal): Promise<OrgGroup[]> {
    return readGroups(await api.get<unknown>('/auth/groups', { signal }));
}

export async function createGroup(body: {
    name: string;
    description: string;
    organizationId: string | null;
}): Promise<void> {
    await api.post('/auth/groups', body);
}

/** One key at a time, as the web sends it. `orgRole: ''` is "User (default)". */
export type GroupPatch = { description: string } | { orgRole: string } | { allowedTiers: string[] };

export async function updateGroup(id: string, patch: GroupPatch): Promise<void> {
    await api.put(`/auth/groups/${seg(id)}`, patch);
}

export async function deleteGroup(id: string): Promise<void> {
    await api.delete(`/auth/groups/${seg(id)}`);
}

export async function addGroupMember(groupId: string, userId: string): Promise<void> {
    await api.post(`/auth/groups/${seg(groupId)}/members`, { userId });
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
    await api.delete(`/auth/groups/${seg(groupId)}/members/${seg(userId)}`);
}

// ── Roles ──────────────────────────────────────────────────────────────

export async function getOrgRoles(signal?: AbortSignal): Promise<OrgRoles> {
    return readOrgRoles(await api.get<unknown>('/auth/org-roles', { signal }));
}

/** Answers what the server stored (it drops anything outside the editable set). */
export async function saveRolePermissions(roleId: string, permissions: string[]): Promise<string[] | null> {
    return readSavedRolePermissions(await api.put<unknown>(`/auth/org-roles/${seg(roleId)}`, { permissions }));
}

// ── Model tiers ────────────────────────────────────────────────────────

/** Non-critical on the web too: a refusal reads as "no custom tiers". */
export async function getCustomTiersList(signal?: AbortSignal): Promise<CustomTierMeta[]> {
    const list = await optional(async () =>
        readCustomTiersList(await api.get<unknown>('/ai/config/custom-tiers-list', { signal })),
    );
    return list ?? [];
}

export async function getOrgCustomTiers(signal?: AbortSignal): Promise<OrgCustomTiers> {
    return readOrgCustomTiers(await api.get<unknown>('/ai/config/org-custom-chat-models', { signal }));
}

export async function saveOrgCustomTiers(tiers: CustomTier[]): Promise<SaveTiersResult> {
    return readSaveTiersResult(await api.post<unknown>('/ai/config/org-custom-chat-models', { tiers }));
}

/** Every model of every provider, as the web's tier editor lists them. */
export async function listModelOptions(signal?: AbortSignal): Promise<ModelOption[]> {
    const providers = readProviders(await api.get<unknown>('/ai/providers', { signal }));
    const lists = await Promise.all(
        providers.map(async (p) => {
            try {
                return readModels(await api.get<unknown>(`/ai/providers/${seg(p.id)}/models`, { signal }), p.name);
            } catch {
                // One provider that cannot list its models must not empty the picker.
                return [];
            }
        }),
    );
    return lists.flat();
}

// ── Access ─────────────────────────────────────────────────────────────

export async function getGroupAccess(orgId: string, signal?: AbortSignal): Promise<GroupAccess> {
    return readGroupAccess(await api.get<unknown>(`/auth/organizations/${seg(orgId)}/group-access`, { signal }));
}

export async function setOrgAccess(orgId: string, granted: string[]): Promise<void> {
    await api.put(`/auth/organizations/${seg(orgId)}/org-access`, { granted });
}

export async function setGroupAccess(groupId: string, granted: string[]): Promise<void> {
    await api.put(`/auth/groups/${seg(groupId)}/access`, { granted });
}
