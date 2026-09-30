/** Contract readers for the people, groups, roles, tiers and access payloads. */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

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

/** An id the store may hand back as a number (a serial column) or a string. */
function idOf(value: unknown): string {
    if (typeof value === 'string') return value;
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** `groups` is a parsed list; a legacy comma-joined string is split. */
function groupIds(value: unknown): string[] {
    if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
    return field.strArray(value);
}

export const readMembers: (raw: unknown) => Member[] = shapeListOf({
    id: field.str(''),
    username: field.optStr,
    displayName: field.optStr,
    firstName: field.optStr,
    lastName: field.optStr,
    email: field.optStr,
    phone: field.optStr,
    role: field.optStr,
    orgRole: field.optStr,
    status: field.optStr,
    organizationId: field.optStr,
    avatar: field.strOrNull,
    avatarType: field.strOrNull,
    groups: groupIds,
    isSystem: field.optBool,
    provider: field.optStr,
    mfaEnabled: field.optBool,
    lastSeenAt: field.strOrNull,
    createdAt: field.optStr,
});

export const readGroups: (raw: unknown) => OrgGroup[] = shapeListOf({
    id: field.str(''),
    name: field.str(''),
    description: field.optStr,
    organizationId: field.optStr,
    orgRole: field.optStr,
    allowedTiers: field.strArray,
    source: field.optStr,
});

export const readInvitations: (raw: unknown) => Invitation[] = shapeListOf({
    id: idOf,
    email: field.str(''),
    role: field.optStr,
    status: field.optStr,
    inviterName: field.optStr,
    created_at: field.optStr,
    expires_at: field.optStr,
});

export const readInviteResult: (raw: unknown) => InviteResult = shapeOf({
    success: field.bool(false),
    emailSent: field.bool(false),
    inviteUrl: field.strOrNull,
});

const readRoleRows = shapeListOf({ id: field.str(''), permissions: field.strArray });

export function readOrgRoles(raw: unknown): OrgRoles {
    return {
        roles: readRoleRows(pick(raw, 'roles')).filter((r) => r.id !== ''),
        editablePermissions: field.strArray(pick(raw, 'editablePermissions')),
    };
}

/** `PUT /auth/org-roles/:roleId` answers what it stored, sanitised. */
export function readSavedRolePermissions(raw: unknown): string[] | null {
    return field.strArrayOrNull(pick(raw, 'permissions'));
}

/** `{ success, wasEnabled }` from `POST /auth/users/:id/mfa/reset`. */
export function readMfaReset(raw: unknown): { wasEnabled: boolean } {
    return { wasEnabled: field.bool(true)(pick(raw, 'wasEnabled')) };
}

const readTierMeta = shapeListOf({
    id: field.str(''),
    label: field.str(''),
    icon: field.optStr,
    description: field.optStr,
    scope: field.optStr,
});

export function readCustomTiersList(raw: unknown): CustomTierMeta[] {
    return readTierMeta(pick(raw, 'tiers')).filter((t) => t.id !== '');
}

const readTierFields = shapeOf({
    id: field.str(''),
    label: field.str(''),
    icon: field.str('✨'),
    description: field.str(''),
    modelId: field.str(''),
    euModelId: field.str(''),
    maxTokens: field.num(16384),
    temperature: field.num(0.7),
    allowedTaskTypes: field.strArray,
});

/** Validated fields over the stored row, so unknown keys survive a round trip. */
function readTier(raw: unknown): CustomTier {
    const base = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return { ...(base as Record<string, unknown>), ...readTierFields(raw) };
}

function readTierList(raw: unknown): CustomTier[] {
    return Array.isArray(raw) ? raw.map(readTier).filter((t) => t.id !== '') : [];
}

export function readOrgCustomTiers(raw: unknown): OrgCustomTiers {
    return {
        orgTiers: readTierList(pick(raw, 'orgTiers')),
        globalTiers: readTierMeta(pick(raw, 'globalTiers')).filter((t) => t.id !== ''),
    };
}

export function readSaveTiersResult(raw: unknown): SaveTiersResult {
    const tiers = pick(raw, 'tiers');
    return {
        tiers: Array.isArray(tiers) ? readTierList(tiers) : null,
        warnings: field.strArray(pick(raw, 'warnings')),
    };
}

const readProviderRows = shapeListOf({ id: field.str(''), name: field.str('') });

export function readProviders(raw: unknown): { id: string; name: string }[] {
    return readProviderRows(pick(raw, 'providers')).filter((p) => p.id !== '');
}

const readModelRows = shapeListOf({ id: field.str(''), name: field.optStr });

export function readModels(raw: unknown, providerName: string): ModelOption[] {
    return readModelRows(pick(raw, 'models'))
        .filter((m) => m.id !== '')
        .map((m) => ({ id: m.id, name: m.name || m.id, providerName }));
}

const readAccessFields = shapeOf({
    orgId: field.strOrNull,
    mode: field.str(''),
    capabilities: field.list(
        shapeOf({
            id: field.str(''),
            kind: field.str('core'),
            name: field.str(''),
            description: field.optStr,
            category: field.optStr,
            lifecycle: field.optStr,
        }),
    ),
    ceiling: field.strArray,
    everyone: field.strArray,
    groups: field.list(shapeOf({ id: field.str(''), name: field.str(''), granted: field.strArray })),
    betaGoverned: field.bool(false),
});

export function readGroupAccess(raw: unknown): GroupAccess {
    const read = readAccessFields(raw);
    return {
        ...read,
        capabilities: read.capabilities.filter((c) => c.id !== ''),
        groups: read.groups.filter((g) => g.id !== ''),
    };
}
