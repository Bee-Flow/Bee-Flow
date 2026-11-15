import { Plus, Shield } from 'lucide-react';
import GroupCard from './GroupCard';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import { INPUT } from '@/components/shared/adminUi';
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
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('admin.org_new_group', 'Create New Group')}</h3>
            <input
                type="text"
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                className={INPUT}
                placeholder={t('admin_org.users_group_name_ph', 'Group name')}
                autoFocus
            />
            <input
                type="text"
                value={newGroupDesc}
                onChange={e => setNewGroupDesc(e.target.value)}
                className={INPUT}
                placeholder={t('admin_org.users_desc_optional_ph', 'Description (optional)')}
            />
            {organizations.length > 1 && (
                <select
                    value={newGroupOrg}
                    onChange={e => setNewGroupOrg(e.target.value)}
                    className={INPUT}
                >
                    {organizations.map(org => (
                        <option key={org.id} value={org.id}>{org.name}</option>
                    ))}
                </select>
            )}
            <div className="flex gap-2 justify-end">
                <Button variant="secondary" onClick={() => { setShowCreateGroup(false); setNewGroupName(''); setNewGroupDesc(''); }}>
                    {t('admin.org_cancel', 'Cancel')}
                </Button>
                <Button variant="primary" onClick={handleCreateGroup} busy={creatingGroup} disabled={!newGroupName.trim()}>
                    {creatingGroup ? t('admin.org_creating', 'Creating...') : t('admin.org_create', 'Create')}
                </Button>
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
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 border-dashed border-[var(--border-default)] text-sm font-medium text-[var(--text-secondary)] hover:border-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    {t('admin.org_new_group', 'Create New Group')}
                </button>
            ) : (
                <CreateGroupForm organizations={organizations} groupsState={groupsState} />
            )}

            {/* Groups list */}
            {orgGroups.length === 0 && !showCreateGroup ? (
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-5 py-12 text-center">
                    <Shield className="w-10 h-10 mx-auto mb-3 text-[var(--text-tertiary)]" aria-hidden="true" />
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
