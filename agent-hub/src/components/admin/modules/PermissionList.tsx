import { Check, ServerCrash, ShieldAlert } from 'lucide-react';
import { normalizePermissions, permissionCopy, splitEnvPermissions } from './permissionCopy';
import type { ModulePermission } from './permissionCopy';
import { useTranslation } from '@/hooks/useTranslation';
import { CHIP_SUCCESS, CHIP_WARNING } from '@/components/shared/adminUi';

interface PermissionListProps {
    permissions?: unknown;
    granted?: { list?: string[] } | null;
    diff?: string[] | null;
}

// Permission list shared by the consent dialog (pre-install review) and the
// detail drawer's Permissions tab (granted state). `granted` is the drawer's
// grantedPermissions object; `diff` marks ids that are NEW in an update.

function PermissionRow({ perm, granted, isNew }: { perm: ModulePermission; granted: boolean; isNew: boolean }) {
    const { t } = useTranslation();
    return (
        <li className="flex items-start gap-2.5 py-2" data-testid={`perm-${perm.id}`}>
            <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--text-muted)]" />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-[var(--text-primary)]">
                        {permissionCopy(t, perm.id)}
                    </span>
                    {isNew && (
                        <span className={CHIP_WARNING}>
                            {t('modules.permissions.new')}
                        </span>
                    )}
                    {granted && (
                        <span className={CHIP_SUCCESS}>
                            <Check className="w-2.5 h-2.5" /> {t('modules.permissions.granted')}
                        </span>
                    )}
                </div>
                {perm.reason && (
                    <p className="text-xs mt-0.5 leading-relaxed text-[var(--text-secondary)]">{perm.reason}</p>
                )}
                <code className="text-[10px] text-[var(--text-muted)]">{perm.id}</code>
            </div>
        </li>
    );
}

export default function PermissionList({ permissions, granted = null, diff = null }: PermissionListProps) {
    const { t } = useTranslation();
    const perms = normalizePermissions(permissions);
    if (perms.length === 0) {
        return <p className="text-xs text-[var(--text-muted)]">{t('modules.permissions.none')}</p>;
    }

    const { normal, env } = splitEnvPermissions(perms);
    const grantedSet = new Set(granted?.list || []);
    const diffSet = new Set(diff || []);

    return (
        <div className="space-y-3">
            {normal.length > 0 && (
                <ul className="divide-y border-[var(--border-subtle)]">
                    {normal.map((p: ModulePermission) => (
                        <PermissionRow key={p.id} perm={p} granted={grantedSet.has(p.id)} isNew={diffSet.has(p.id)} />
                    ))}
                </ul>
            )}
            {env.length > 0 && (
                <div className="rounded-lg border p-3 border-[color-mix(in_srgb,var(--error)_35%,transparent)] bg-[color-mix(in_srgb,var(--error)_6%,transparent)]" data-testid="perm-env-section">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--error-ink)]">
                        <ServerCrash className="w-3.5 h-3.5" /> {t('modules.permissions.env_section')}
                    </div>
                    <p className="text-xs mt-1 leading-relaxed text-[var(--text-secondary)]">
                        {t('modules.permissions.env_disclaimer')}
                    </p>
                    <ul className="divide-y mt-1 border-[var(--border-subtle)]">
                        {env.map((p: ModulePermission) => (
                            <PermissionRow key={p.id} perm={p} granted={grantedSet.has(p.id)} isNew={diffSet.has(p.id)} />
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
