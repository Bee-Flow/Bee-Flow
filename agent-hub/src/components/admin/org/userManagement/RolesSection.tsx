import { Edit2, Tag, Trash2 } from 'lucide-react';
import type { AdminRole } from './types';
import { AddButton, EntityList, EntityRow, EntitySectionHeader, RowAction } from './EntityRows';
import { useTranslation } from '@/hooks/useTranslation';

export interface RolesSectionProps {
    roles: AdminRole[];
    onAddRole: () => void;
    onEditRole: (role: AdminRole) => void;
    onDeleteRole: (roleId: string) => void;
}

export default function RolesSection({ roles, onAddRole, onEditRole, onDeleteRole }: RolesSectionProps) {
    const { t } = useTranslation();
    return (
        <div>
            <EntitySectionHeader
                title={t('admin_org.roles_section_title', 'Roles')}
                description={t('admin_org.roles_section_subtitle', 'Define role templates with permissions')}
                action={<AddButton onClick={onAddRole} icon={<Tag className="h-3.5 w-3.5" aria-hidden="true" />}>{t('admin_org.roles_section_add', 'Add Role')}</AddButton>}
            />
            <EntityList>
                {roles.map(role => (
                    <EntityRow
                        key={role.id}
                        icon={<Tag className="h-4 w-4" />}
                        title={role.name}
                        description={role.description}
                        chips={role.permissions}
                        actions={<>
                            <RowAction label={`${t('common.edit', 'Edit')} ${role.name}`} onClick={() => onEditRole(role)}><Edit2 /></RowAction>
                            {role.id !== 'admin' && role.id !== 'user' && <RowAction danger label={`${t('common.delete', 'Delete')} ${role.name}`} onClick={() => onDeleteRole(role.id)}><Trash2 /></RowAction>}
                        </>}
                    />
                ))}
            </EntityList>
        </div>
    );
}
