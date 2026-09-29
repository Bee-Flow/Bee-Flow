import { Key } from 'lucide-react';
import type { AdminPermission } from './types';

export interface PermissionsSectionProps {
    permissions: AdminPermission[];
}

export default function PermissionsSection({ permissions }: PermissionsSectionProps) {
    return (
        <div className="space-y-4">
            <div className="mb-6"><h3 className="text-lg font-semibold text-[var(--text-primary)]">Permissions</h3><p className="text-sm text-[var(--text-muted)]">Available permissions for roles and groups</p></div>
            <div className="grid gap-3">
                {permissions.map(perm => (
                    <div key={perm.id} className="p-4 rounded-xl border flex items-center justify-between bg-[var(--bg-secondary)] border-[var(--border-default)]">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(59, 130, 246, 0.15)' }}><Key className="w-5 h-5 text-blue-400" /></div>
                            <div><h4 className="font-medium text-[var(--text-primary)]">{perm.name}</h4><p className="text-sm text-[var(--text-muted)]">{perm.description}</p></div>
                        </div>
                        <code className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{perm.id}</code>
                    </div>
                ))}
            </div>
        </div>
    );
}
