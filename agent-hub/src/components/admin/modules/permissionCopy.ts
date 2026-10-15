// Canonical operator-facing copy for module permission ids (mv2 manifests).
// Pure helpers shared by PermissionList / PermissionConsentDialog and unit-
// tested directly. Copy lives in the i18n dict; this maps ids → keys.

// Fixed ids → dict keys (variable lookup, not literal t() calls, so the i18n
// guard's literal-call check skips the indirection; every value is in the dict).
import type { TranslateFn } from '../../../hooks/useTranslation';

/** One permission of a manifest, as the server sends it (a bare id or an object). */
export interface PermissionEntry {
    id: string;
    reason?: string | null;
}

const PERM_KEY: Readonly<Record<string, string>> = {
    'db': 'modules.permissions.db',
    'ai': 'modules.permissions.ai',
    'usage:write': 'modules.permissions.usage_write',
    'limits:read': 'modules.permissions.limits_read',
    'storage:read': 'modules.permissions.storage_read',
    'webpages:write': 'modules.permissions.webpages_write',
    'email:send': 'modules.permissions.email_send',
    'license:read': 'modules.permissions.license_read',
    'config': 'modules.permissions.config',
};

/**
 * Server payloads carry permissions either as bare id strings or as
 * { id, reason? } objects — normalise to the object shape.
 */
export const normalizePermissions = (list: unknown): PermissionEntry[] => (Array.isArray(list) ? (list as unknown[]) : [])
    .map((p): PermissionEntry | null => (typeof p === 'string' ? { id: p } : (p as PermissionEntry | null)))
    .filter((p): p is PermissionEntry => !!p && typeof p.id === 'string' && !!p.id);

/** env:* ids run with server privileges and render in their own section. */
export const isEnvPermission = (id: unknown): boolean => typeof id === 'string' && id.startsWith('env:');

export function splitEnvPermissions(perms: PermissionEntry[]): { normal: PermissionEntry[]; env: PermissionEntry[] } {
    const normal: PermissionEntry[] = [];
    const env: PermissionEntry[] = [];
    for (const p of perms) (isEnvPermission(p.id) ? env : normal).push(p);
    return { normal, env };
}

/** Human copy for one permission id (t = useTranslation().t). */
export function permissionCopy(t: TranslateFn, id: string): string {
    const key = PERM_KEY[id];
    if (key) return t(key);
    if (typeof id === 'string' && id.startsWith('http:')) {
        const pattern = id.slice('http:'.length) || '*';
        return t('modules.permissions.http', {
            pattern: pattern === '*' ? t('modules.permissions.http_any') : pattern,
        });
    }
    if (isEnvPermission(id)) return t('modules.permissions.env_item', { id });
    return t('modules.permissions.unknown', { id });
}
