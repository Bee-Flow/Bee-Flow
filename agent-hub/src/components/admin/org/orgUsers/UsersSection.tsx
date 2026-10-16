import { Search, Send, UserPlus, Users } from 'lucide-react';
import AutoApproveCard from './AutoApproveCard';
import InviteForm from './InviteForm';
import OrgMemberRow from './OrgMemberRow';
import PendingInvitations from './PendingInvitations';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { UseUserFiltersReturn } from '../../../../hooks/useUserFilters';
import UserFilterBar from '../../shared/UserFilterBar';
import OrgHealthBanner from '../OrgHealthBanner';
import type { OrgDirectory, OrgGroupRow, OrgMember } from '../useOrgDirectory';
import type { OrgGroups } from '../useOrgGroups';
import type { OrgInvitations } from '../useOrgInvitations';
import type { OrgMemberRoles } from '../useOrgMemberRoles';

interface UsersSectionProps {
    directory: OrgDirectory;
    /** Members without the system rows. */
    orgUsers: OrgMember[];
    orgGroups: OrgGroupRow[];
    groupsState: OrgGroups;
    invites: OrgInvitations;
    memberRoles: OrgMemberRoles;
    /** Owned by the panel, so the filters survive a switch to another tab. */
    userFilters: UseUserFiltersReturn;
    /** Leave for the Groups tab (optionally straight into its create form). */
    onGoToGroups: (createGroup?: boolean) => void;
}

function NoMembersYet({ onManageGroups }: { onManageGroups: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="px-5 py-12 text-center">
            <Users className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-30" />
            <p className="text-sm font-medium text-[var(--text-primary)]">{t('admin.org_no_users', 'No users yet')}</p>
            <p className="text-xs text-[var(--text-muted)] mt-1 max-w-sm mx-auto">
                {t('admin.org_no_users_desc', 'Users will appear here once they are assigned to your organisation. Add users via the admin panel or invite them by sharing a signup link.')}
            </p>
            <div className="flex items-center justify-center gap-3 mt-4">
                <button
                    onClick={onManageGroups}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity"
                >
                    <UserPlus className="w-4 h-4" />
                    {t('admin_org.users_manage_groups', 'Manage Groups')}
                </button>
            </div>
        </div>
    );
}

/**
 * The Users tab: connector health, the auto-approve switch, the invite form,
 * the filtered member list and the pending invitations.
 */
export default function UsersSection({ directory, orgUsers, orgGroups, groupsState, invites, memberRoles, userFilters, onGoToGroups }: UsersSectionProps) {
    const { t } = useTranslation();
    const { usageByUser, orgAuthMethod, autoApprove, savingAutoApprove, handleToggleAutoApprove } = directory;
    // The hook filters its input without mapping it, so every row is a member.
    const filteredOrgUsers = userFilters.filtered as OrgMember[];
    const pendingInvitations = invites.invitations.filter(i => i.status === 'pending');
    const { setGroupAssignOpenFor } = groupsState;
    const openCreateGroup = () => { setGroupAssignOpenFor(null); onGoToGroups(true); };

    return (
        <>
        {/* Connector-health blockers (pending approvals / org-level
            blocks). Renders null for healthy or non-connector orgs. */}
        <OrgHealthBanner />
        {/* Auto-approve toggle — only meaningful when the org's sign-in
            method is an external provider (Google/Microsoft). */}
        {orgAuthMethod && orgAuthMethod !== 'password' && (
            <AutoApproveCard autoApprove={autoApprove} saving={savingAutoApprove} onToggle={handleToggleAutoApprove} />
        )}
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] rounded-t-xl flex items-center justify-between">
                <div>
                    <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin.org_members_title', 'Organisation Members')}</h3>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{t('admin.org_members_desc', 'Manage roles and group assignments for users in your organisation')}</p>
                </div>
                <button
                    onClick={() => { invites.setShowInviteForm(v => !v); invites.setInviteResult(null); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity"
                >
                    <Send className="w-3.5 h-3.5" />
                    {t('admin.org_invite_user', 'Invite User')}
                </button>
            </div>

            {invites.showInviteForm && <InviteForm {...invites} />}
            {orgUsers.length === 0 ? (
                <NoMembersYet onManageGroups={() => onGoToGroups()} />
            ) : (
                <>
                    <UserFilterBar
                        filters={userFilters.filters}
                        setFilter={userFilters.setFilter}
                        clear={userFilters.clear}
                        active={userFilters.active}
                        shownCount={filteredOrgUsers.length}
                        totalCount={orgUsers.length}
                        groups={orgGroups}
                    />
                    {filteredOrgUsers.length === 0 ? (
                        <div className="px-5 py-10 text-center">
                            <Search className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] opacity-30" />
                            <p className="text-xs text-[var(--text-muted)]">
                                {t('admin.org_no_matches', 'No users match the current filters.')}
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-[var(--border-subtle)]">
                            {filteredOrgUsers.map(u => (
                                <OrgMemberRow
                                    key={u.id}
                                    member={u}
                                    orgGroups={orgGroups}
                                    usage={usageByUser.get(u.id)}
                                    groupsState={groupsState}
                                    memberRoles={memberRoles}
                                    onCreateGroup={openCreateGroup}
                                />
                            ))}
                        </div>
                    )}
                </>
            )}

            {/* Pending Invitations */}
            {pendingInvitations.length > 0 && (
                <PendingInvitations pending={pendingInvitations} onRevoke={invites.handleRevokeInvite} />
            )}
        </div>
        </>
    );
}
