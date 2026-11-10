/**
 * The organisation-wide Teams import setting (option B), one configStore
 * document per organisation: `org_${orgId}_teams_app_import`.
 *
 *   { enabled, coverage: 'all' | 'selected', selectedUserIds, tenantId,
 *     enabledAt, enabledBy, updatedAt, updatedBy }
 *
 * Off by default: a missing or unreadable document, or anything but
 * `enabled === true`, is off. `tenantId` is the organisation's verified
 * Microsoft tenant at the moment it was switched on (orgTenant.mts); while it
 * stays on that snapshot is kept, so a tenant link that moves later does not
 * silently extend the import to another tenant (coverage.mts: tenant_changed).
 * Switching off clears the tenant and who switched it on.
 *
 * Every save writes an audit row (`teams_app_import_enabled | _disabled |
 * _updated`) with the switch, the coverage, the NUMBER of selected members and
 * the tenant: never a user id or a name. The document is deleted with the
 * organisation (the `org_${orgId}_%` sweep); account erasure takes the user
 * out of every organisation's document (`forgetUserInAllAppImports`, the
 * `content` erasure port of stores/user/erasurePorts.js, through
 * projects/accountContentErasure.js).
 *
 * Storage only: who may change it, and the rules a change must follow, live
 * in coverage.mts (`updateAppImport`). This module never decides coverage.
 */

import { createRequire } from 'node:module';
import { GUID } from '../../../auth/oauth/microsoftConnections.mts';

const nodeRequire = createRequire(import.meta.url);

export type AppImportCoverage = 'all' | 'selected';

export interface AppImportSettings {
    enabled: boolean;
    coverage: AppImportCoverage;
    selectedUserIds: string[];
    tenantId: string | null;
    enabledAt: string | null;
    enabledBy: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
}

export type AppImportAuditAction = 'teams_app_import_enabled' | 'teams_app_import_disabled' | 'teams_app_import_updated';

interface ConfigStoreLike {
    getConfig(key: string): Promise<unknown>;
    getConfigFresh(key: string): Promise<unknown>;
    setConfig(key: string, value: unknown): Promise<unknown>;
    listKeysWithPrefix(prefix: string): Promise<string[]>;
}

interface SettingsDeps {
    configStore: ConfigStoreLike;
    logAccessAudit: (action: string, targetType: string, targetId: string, changedBy: string | null, oldValues: unknown, newValues: unknown, organizationId?: string | null) => Promise<unknown>;
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<SettingsDeps>({
    configStore: () => nodeRequire('../../../stores/configStore.js'),
    // The audit module itself, not userStore: account erasure (stores/user/usersDelete.js)
    // calls this module, and userStore reaches usersDelete, which would close an import loop.
    logAccessAudit: () => (nodeRequire('../../../stores/user/audit.js') as Pick<SettingsDeps, 'logAccessAudit'>).logAccessAudit,
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<SettingsDeps> = {}): void { lazy.init(overrides); }

const KEY_PREFIX = 'org_';
const KEY_SUFFIX = '_teams_app_import';

/** The configStore key of an organisation's setting. */
export function appImportKey(orgId: string): string {
    return `${KEY_PREFIX}${orgId}${KEY_SUFFIX}`;
}

const MAX_ID_LENGTH = 128;

function idOrNull(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH ? v : null;
}

function isoOrNull(v: unknown): string | null {
    if (typeof v !== 'string' || !v) return null;
    return Number.isFinite(new Date(v).getTime()) ? v : null;
}

/** The distinct member ids, in first-seen order; anything that is not an id is dropped. */
export function uniqueIds(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of list) {
        const id = idOrNull(typeof v === 'string' ? v.trim() : v);
        if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
}

/** The default (off, nobody selected). */
export function defaultAppImportSettings(): AppImportSettings {
    return { enabled: false, coverage: 'selected', selectedUserIds: [], tenantId: null, enabledAt: null, enabledBy: null, updatedAt: null, updatedBy: null };
}

/** A stored document as settings; anything unexpected reads as the default for that field (off). */
export function normalizeAppImportSettings(raw: unknown): AppImportSettings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultAppImportSettings();
    const r = raw as Record<string, unknown>;
    const tenant = typeof r.tenantId === 'string' && GUID.test(r.tenantId) ? r.tenantId.toLowerCase() : null;
    return {
        enabled: r.enabled === true,
        coverage: r.coverage === 'all' ? 'all' : 'selected',
        selectedUserIds: uniqueIds(r.selectedUserIds),
        tenantId: tenant,
        enabledAt: isoOrNull(r.enabledAt),
        enabledBy: idOrNull(r.enabledBy),
        updatedAt: isoOrNull(r.updatedAt),
        updatedBy: idOrNull(r.updatedBy),
    };
}

/**
 * The organisation's setting. `fresh` reads the database instead of this
 * replica's config cache: the claim of an import job uses it, so a switch-off
 * on another replica counts at once.
 */
export async function readAppImportSettings(orgId: string | null | undefined, { fresh = false }: { fresh?: boolean } = {}): Promise<AppImportSettings> {
    if (!orgId) return defaultAppImportSettings();
    const key = appImportKey(orgId);
    const raw = fresh ? await lazy.deps.configStore.getConfigFresh(key) : await lazy.deps.configStore.getConfig(key);
    return normalizeAppImportSettings(raw);
}

/** What the audit row says about a setting: no user id, no name. */
export function auditValues(s: AppImportSettings | null): { enabled: boolean; coverage: AppImportCoverage; selectedCount: number; tenantId: string | null } | null {
    if (!s) return null;
    return { enabled: s.enabled, coverage: s.coverage, selectedCount: s.selectedUserIds.length, tenantId: s.tenantId };
}

export function auditActionFor(previous: AppImportSettings, next: AppImportSettings): AppImportAuditAction {
    if (!previous.enabled && next.enabled) return 'teams_app_import_enabled';
    if (previous.enabled && !next.enabled) return 'teams_app_import_disabled';
    return 'teams_app_import_updated';
}

/**
 * Store `next` (already checked by coverage.mts updateAppImport) and audit
 * the change. The stamp is set here.
 */
export async function writeAppImportSettings(a: { orgId: string; actorId: string; previous: AppImportSettings; next: Omit<AppImportSettings, 'updatedAt' | 'updatedBy'>; now?: Date }): Promise<AppImportSettings> {
    const stored: AppImportSettings = normalizeAppImportSettings({
        ...a.next,
        updatedAt: (a.now || new Date()).toISOString(),
        updatedBy: a.actorId,
    });
    await lazy.deps.configStore.setConfig(appImportKey(a.orgId), stored);
    await lazy.deps.logAccessAudit(auditActionFor(a.previous, stored), 'organization', a.orgId, a.actorId, auditValues(a.previous), auditValues(stored), a.orgId);
    return stored;
}

/**
 * Account erasure: take `userId` out of the organisation's setting (selected
 * members, who switched it on, who saved last). Writes only when the user
 * was named. No audit row: nothing about the setting itself changed.
 */
export async function forgetUserInAppImport(userId: string, orgId: string | null | undefined): Promise<boolean> {
    if (!userId || !orgId) return false;
    const key = appImportKey(orgId);
    const raw = await lazy.deps.configStore.getConfigFresh(key);
    if (!raw) return false;
    const s = normalizeAppImportSettings(raw);
    const named = s.selectedUserIds.includes(userId) || s.enabledBy === userId || s.updatedBy === userId;
    if (!named) return false;
    await lazy.deps.configStore.setConfig(key, {
        ...s,
        selectedUserIds: s.selectedUserIds.filter((id) => id !== userId),
        enabledBy: s.enabledBy === userId ? null : s.enabledBy,
        updatedBy: s.updatedBy === userId ? null : s.updatedBy,
    });
    return true;
}

/**
 * Account erasure (stores/user/usersDelete.js): take `userId` out of EVERY
 * organisation's setting, not only their current organisation's: an account
 * that moved keeps its id in the old one. One key listing (an index range
 * read, no values), then a fresh read of each setting. Returns how many named
 * the user. A failure rejects, so the erasure is reported incomplete.
 */
export async function forgetUserInAllAppImports(userId: string): Promise<number> {
    if (!userId) return 0;
    const keys = await lazy.deps.configStore.listKeysWithPrefix(KEY_PREFIX);
    let changed = 0;
    for (const key of keys) {
        if (!key.endsWith(KEY_SUFFIX) || key.length <= KEY_PREFIX.length + KEY_SUFFIX.length) continue;
        const orgId = key.slice(KEY_PREFIX.length, key.length - KEY_SUFFIX.length);
        if (await forgetUserInAppImport(userId, orgId)) changed++;
    }
    return changed;
}
