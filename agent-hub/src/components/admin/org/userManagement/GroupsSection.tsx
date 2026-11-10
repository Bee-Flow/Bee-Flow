import { Edit2, Shield, Trash2 } from 'lucide-react';
import type { AdminGroup, AdminOrganization, AdminUser } from './types';
import { AddButton, EntityList, EntityRow, EntitySectionHeader, OrgIcon, RowAction } from './EntityRows';
import { CHIP } from '@/components/mcpLibrary/ui';
import { useTranslation } from '@/hooks/useTranslation';

export interface GroupsSectionProps {
    groups: AdminGroup[];
    organizations: AdminOrganization[];
    users: AdminUser[];
    canManageUsers: boolean;
    onAddGroup: () => void;
    onEditGroup: (group: AdminGroup) => void;
    onDeleteGroup: (groupId: string) => void;
}

interface GroupListProps {
    groups: AdminGroup[];
    users: AdminUser[];
    /** The built-in groups (admins, users) cannot be deleted; org groups always can. */
    builtInsProtected: boolean;
    onEditGroup: (group: AdminGroup) => void;
    onDeleteGroup: (groupId: string) => void;
}

function GroupList({ groups, users, builtInsProtected, onEditGroup, onDeleteGroup }: GroupListProps) {
    const { t } = useTranslation();
    return (
        <EntityList>
            {groups.map(group => {
                const count = users.filter(u => (u.groups || []).includes(group.id)).length;
                const deletable = !builtInsProtected || (group.id !== 'admins' && group.id !== 'users');
                return (
                    <EntityRow
                        key={group.id}
                        icon={<Shield className="h-4 w-4" />}
                        title={group.name}
                        description={group.description}
                        chips={group.permissions}
                        actions={<>
                            <span className={CHIP}>{count === 1 ? t('admin_org.groups_section_member_one', '1 member') : t('admin_org.groups_section_members', '{count} members', { count })}</span>
                            <RowAction label={`${t('common.edit', 'Edit')} ${group.name}`} onClick={() => onEditGroup(group)}><Edit2 /></RowAction>
                            {deletable && <RowAction danger label={`${t('common.delete', 'Delete')} ${group.name}`} onClick={() => onDeleteGroup(group.id)}><Trash2 /></RowAction>}
                        </>}
                    />
                );
            })}
        </EntityList>
    );
}

const GROUP_HEADING = 'm-0 mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';

export default function GroupsSection({ groups, organizations, users, canManageUsers, onAddGroup, onEditGroup, onDeleteGroup }: GroupsSectionProps) {
    const { t } = useTranslation();
    const globalGroups = groups.filter(g => !g.organizationId);
    return (
        <div>
            <EntitySectionHeader
                title={t('admin_org.groups_section_title', 'Groups')}
                description={t('admin_org.groups_section_subtitle', 'Organize users and assign permissions')}
                action={canManageUsers ? <AddButton onClick={onAddGroup} icon={<Shield className="h-3.5 w-3.5" aria-hidden="true" />}>{t('admin_org.groups_section_add', 'Add Group')}</AddButton> : undefined}
            />
            <div className="flex flex-col gap-6">
                {globalGroups.length > 0 && (
                    <section>
                        <h4 className={GROUP_HEADING}>{t('admin_org.groups_section_global', 'Global Groups')}</h4>
                        <GroupList groups={globalGroups} users={users} builtInsProtected onEditGroup={onEditGroup} onDeleteGroup={onDeleteGroup} />
                    </section>
                )}
                {organizations.map(org => {
                    const orgGroups = groups.filter(g => g.organizationId === org.id);
                    if (orgGroups.length === 0) return null;
                    return (
                        <section key={org.id}>
                            <h4 className={GROUP_HEADING}><OrgIcon className="h-3.5 w-3.5" />{org.name}</h4>
                            <GroupList groups={orgGroups} users={users} builtInsProtected={false} onEditGroup={onEditGroup} onDeleteGroup={onDeleteGroup} />
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
