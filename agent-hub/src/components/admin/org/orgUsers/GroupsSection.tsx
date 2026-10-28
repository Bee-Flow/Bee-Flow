import { Plus, Shield } from 'lucide-react';
import GroupCard from './GroupCard';
import { useTranslation } from '@/hooks/useTranslation';
import type { CustomTierMeta, OrgGroupRow, OrgMember, Organization } from '../useOrgDirectory';
import type { OrgGroups } from '../useOrgGroups';

interface GroupsSectionProps {
    orgGroups: OrgGroupRow[];
    orgUsers: OrgMember[];
    organizations: Organization[];
    customTiersMeta: CustomTierMeta[];
    groupsState: OrgGroups;
}

function CreateGroupForm({ organizations, groupsState }: Pick<GroupsSectionProps, 'organizations' | 'groupsState'>) {
    const { t } = useTranslation();
    const {
        setShowCreateGroup, newGroupName, setNewGroupName, newGroupDesc, setNewGroupDesc,
        newGroupOrg, setNewGroupOrg, creatingGroup, handleCreateGroup,
    } = groupsState;
    return (
        <div className="rounded-xl border border-[var(--accent-primary)]/30 bg-[var(--accent-primary)]/5 p-4 space-y-3">
            <div className="text-sm font-medium text-[var(--accent-primary)]">{t('admin.org_new_group', 'Create New Group')}</div>
            <input
                type="text"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent-primary)]"
                placeholder={t('admin_org.users_group_name_ph', 'Group name')}
                autoFocus
            />
            <input
                type="text"
                value={newGroupDesc}
                onChange={e => setNewGroupDesc(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent-primary)]"
                placeholder={t('admin_org.users_desc_optional_ph', 'Description (optional)')}
            />
            {organizations.length > 1 && (
                <select
                    value={newGroupOrg}
                    onChange={e => setNewGroupOrg(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none"
                >
                    {organizations.map(org => (
                        <option key={org.id} value={org.id}>{org.name}</option>
                    ))}
                </select>
            )}
            <div className="flex gap-2 justify-end">
                <button
                    onClick={() => { setShowCreateGroup(false); setNewGroupName(''); setNewGroupDesc(''); }}
                    className="px-3 py-1.5 rounded-lg text-sm text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"
                >
                    {t('admin.org_cancel', 'Cancel')}
                </button>
                <button
                    onClick={handleCreateGroup}
                    disabled={!newGroupName.trim() || creatingGroup}
                    className="px-4 py-1.5 rounded-lg text-sm font-medium text-white bg-[var(--accent-primary)] hover:opacity-90 disabled:opacity-50 transition-all"
                >
                    {creatingGroup ? t('admin.org_creating', 'Creating...') : t('admin.org_create', 'Create')}
                </button>
            </div>
        </div>
    );
}

/** The Groups tab: the create form (or its button) and one card per group. */
export default function GroupsSection({ orgGroups, orgUsers, organizations, customTiersMeta, groupsState }: GroupsSectionProps) {
    const { t } = useTranslation();
    const { showCreateGroup, setShowCreateGroup } = groupsState;
    return (
        <div className="space-y-4">
            {/* Create group */}
            {!showCreateGroup ? (
                <button
                    onClick={() => setShowCreateGroup(true)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-[var(--border-subtle)] text-sm font-medium text-[var(--text-muted)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] transition-all"
                >
                    <Plus className="w-4 h-4" />
                    {t('admin.org_new_group', 'Create New Group')}
                </button>
            ) : (
                <CreateGroupForm organizations={organizations} groupsState={groupsState} />
            )}

            {/* Groups list */}
            {orgGroups.length === 0 && !showCreateGroup ? (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-5 py-12 text-center">
                    <Shield className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-30" />
                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('admin.org_no_groups', 'No groups yet')}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1 max-w-sm mx-auto">
                        {t('admin_org.users_groups_intro', 'Groups let you organise users and control which agents they can access. Create a group to get started.')}
                    </p>
                </div>
            ) : (
                <div className="grid gap-3">
                    {orgGroups.map(group => (
                        <GroupCard
                            key={group.id}
                            group={group}
                            orgUsers={orgUsers}
                            customTiersMeta={customTiersMeta}
                            groupsState={groupsState}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
