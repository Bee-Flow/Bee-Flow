import { ChevronDown, ChevronRight, Edit2, Trash2, Users } from 'lucide-react';
import { GroupMemberAdd, GroupMembersList } from './GroupMembers';
import GroupSettings from './GroupSettings';
import { ORG_ROLES } from '../../../../config/orgRoles';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { CustomTierMeta, OrgGroupRow, OrgMember } from '../useOrgDirectory';
import type { OrgGroups } from '../useOrgGroups';

interface GroupCardProps {
    group: OrgGroupRow;
    orgUsers: OrgMember[];
    customTiersMeta: CustomTierMeta[];
    groupsState: OrgGroups;
}

function GroupSummary({ group }: { group: OrgGroupRow }) {
    const { t } = useTranslation();
    const role = group.orgRole ? ORG_ROLES.find(r => r.id === group.orgRole) : null;
    return (
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {group.description || t('admin_org.users_no_description', 'No description')}
            {role && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded text-white font-medium" style={{ background: role.color }}>
                    {role.name}
                </span>
            )}
            {group.source === 'azure' && group.lastSyncedAt && (
                <span className="ml-2 text-[10px] text-[var(--text-muted)] opacity-60">{t('admin_org.users_last_synced', 'Last synced: {date}', { date: new Date(group.lastSyncedAt).toLocaleString() })}</span>
            )}
        </p>
    );
}

function GroupActions({ group, isSystem, groupsState }: { group: OrgGroupRow; isSystem: boolean; groupsState: OrgGroups }) {
    const { t } = useTranslation();
    const { setExpandedGroup, setEditingGroup, setEditGroupDesc, handleDeleteGroup, getGroupCount } = groupsState;
    const count = getGroupCount(group.id);
    return (
        <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
                <Users className="w-3 h-3" />
                {count === 1 ? t('admin_org.users_member_one', '{count} member', { count }) : t('admin_org.users_member_other', '{count} members', { count })}
            </span>
            {!isSystem && (
                <>
                    <button
                        onClick={(e) => { e.stopPropagation(); setExpandedGroup(group.id); setEditingGroup(group.id); setEditGroupDesc(group.description || ''); }}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        title={t('admin_org.users_edit_group', 'Edit group settings')}
                    >
                        <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    {group.source !== 'azure' && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group.id); }}
                            className="p-1.5 rounded-lg hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                            title={t('admin_org.users_delete_group', 'Delete group')}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </>
            )}
            {group.source === 'azure' && (
                <span className="text-[10px] text-[var(--text-muted)] italic" title={t('admin_org.users_azure_managed_title', 'Managed by Azure AD · sync to update or remove')}>
                    {t('admin_org.users_managed', 'Managed')}
                </span>
            )}
        </div>
    );
}

/** One group on the Groups tab: its summary row and, expanded, its settings and members. */
export default function GroupCard({ group, orgUsers, customTiersMeta, groupsState }: GroupCardProps) {
    const { t } = useTranslation();
    const { expandedGroup, setExpandedGroup } = groupsState;
    const isSystem = group.id === 'admins' || group.id === 'users';
    const expanded = expandedGroup === group.id;
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] transition-all" style={{ borderColor: expanded ? 'var(--border-default)' : undefined }}>
            <div className="flex items-start justify-between gap-3 p-4 cursor-pointer" onClick={() => setExpandedGroup(expanded ? null : group.id)}>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{group.name}</span>
                        {isSystem && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500 font-medium">{t('admin_org.users_system', 'System')}</span>
                        )}
                        {group.source === 'azure' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#0078D4]/15 text-[#0078D4] font-medium flex items-center gap-0.5">
                                🪟 Azure AD
                            </span>
                        )}
                    </div>
                    <GroupSummary group={group} />
                </div>
                <GroupActions group={group} isSystem={isSystem} groupsState={groupsState} />
            </div>
            {/* Expanded member list */}
            {expanded && (
                <div className="border-t border-[var(--border-subtle)] px-4 py-3 space-y-4">
                    <GroupSettings group={group} customTiersMeta={customTiersMeta} groupsState={groupsState} />
                    <GroupMemberAdd group={group} orgUsers={orgUsers} groupsState={groupsState} />
                    <GroupMembersList group={group} groupsState={groupsState} />
                </div>
            )}
        </div>
    );
}
