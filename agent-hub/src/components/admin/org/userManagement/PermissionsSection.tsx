import { Key } from 'lucide-react';
import type { AdminPermission } from './types';
import { EntityList, EntityRow, EntitySectionHeader } from './EntityRows';
import { useTranslation } from '@/hooks/useTranslation';

export interface PermissionsSectionProps {
    permissions: AdminPermission[];
}

export default function PermissionsSection({ permissions }: PermissionsSectionProps) {
    const { t } = useTranslation();
    return (
        <div>
            <EntitySectionHeader
                title={t('admin_org.permissions_section_title', 'Permissions')}
                description={t('admin_org.permissions_section_subtitle', 'Available permissions for roles and groups')}
            />
            <EntityList>
                {permissions.map(perm => (
                    <EntityRow
                        key={perm.id}
                        icon={<Key className="h-4 w-4" />}
                        title={perm.name}
                        description={perm.description}
                        actions={<code className="rounded bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-tertiary)]">{perm.id}</code>}
                    />
                ))}
            </EntityList>
        </div>
    );
}
