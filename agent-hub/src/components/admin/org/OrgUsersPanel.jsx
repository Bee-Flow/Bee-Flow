import { Users, UserPlus, Shield, Trash2, Edit2, Check, X, Plus, ChevronDown, ChevronRight, Mail, Clock, Send, Link2, AlertCircle, Search, Sparkles, Cloud } from 'lucide-react';
import React, { useState } from 'react';
import OrgCustomTiersPanel from './OrgCustomTiersPanel';
import OrgHealthBanner from './OrgHealthBanner';
import RolePermissionEditor from './RolePermissionEditor';
import useOrgDirectory from './useOrgDirectory';
import useOrgGroups from './useOrgGroups';
import useOrgInvitations from './useOrgInvitations';
import useOrgMemberRoles from './useOrgMemberRoles';
import { ORG_ROLES, permissionsForRole } from '../../../config/orgRoles';
import { useTranslation } from '../../../hooks/useTranslation';
import { useUrlTab } from '../../../hooks/useUrlTab';
import { useUserFilters } from '../../../hooks/useUserFilters';
import { API_BASE } from '../../../utils/helpers';
import NextcloudSyncPanel from '../../integrations/nextcloud/NextcloudSyncPanel';
import ConfirmDialog from '../../shared/ConfirmDialog';
import RoleBadge from '../../shared/RoleBadge';
import useConfirm from '../../shared/useConfirm';
import UserListSkeleton from '../../shared/UserListSkeleton';
import UserFilterBar from '../shared/UserFilterBar';

// The three sub-tabs map to /app/org-settings/users/{list|groups|roles}.
// The 'list' URL corresponds to the 'users' internal id so the URL segment
// doesn't collide with the parent path (`.../users`).
const ORG_USERS_SECTIONS = ['users', 'groups', 'roles', 'customTiers', 'sync'];
const ORG_USERS_URL_ALIASES = { users: 'list' };

const OrgUsersPanel = ({ user, initialSection: _initialSection }) => {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [activeSection, setActiveSection] = useUrlTab({
        basePath: '/app/org-settings/users',
        validValues: ORG_USERS_SECTIONS,
        defaultValue: 'users',
        aliases: ORG_USERS_URL_ALIASES,
    });
    const {
        users, groups, orgRolePerms, setOrgRolePerms, editablePermissions, organizations,
        loading, customTiersMeta, usageByUser, orgAuthMethod, autoApprove, savingAutoApprove,
        myOrgId, fetchData, handleToggleAutoApprove,
    } = useOrgDirectory({ user });
    const {
        showCreateGroup, setShowCreateGroup,
        newGroupName, setNewGroupName,
        newGroupDesc, setNewGroupDesc,
        newGroupOrg, setNewGroupOrg,
        creatingGroup,
        editingGroup, setEditingGroup,
        editGroupDesc, setEditGroupDesc,
        expandedGroup, setExpandedGroup,
        groupAssignOpenFor, setGroupAssignOpenFor,
        groupAssignSearch, setGroupAssignSearch,
        groupAssignRef,
        memberAddGroupId, setMemberAddGroupId,
        memberAddSearch, setMemberAddSearch,
        memberBusy,
        handleUpdateGroupAllowedTiers, handleCreateGroup, handleDeleteGroup,
        handleUpdateGroupDesc, handleUpdateGroupRole, handleUserGroupToggle,
        getGroupCount, getGroupMembers, addGroupMember, removeGroupMember,
    } = useOrgGroups({ users, organizations, fetchData, confirm });
    const {
        showInviteForm, setShowInviteForm,
        inviteEmail, setInviteEmail,
        inviteRole, setInviteRole,
        sendingInvite,
        inviteResult, setInviteResult,
        invitations,
        handleSendInvite, handleRevokeInvite,
    } = useOrgInvitations();
    const {
        editingUserRole, setEditingUserRole,
        roleChangeError, setRoleChangeError,
        pendingSelfDemotion, setPendingSelfDemotion,
        handleUserRoleChange, handleApproveUser, handleRejectUser,
    } = useOrgMemberRoles({ fetchData, confirm });

    // Expanded role details
    const [expandedRole, setExpandedRole] = useState(null);

    // Resolve org IDs from user's direct assignment and groups
    const getUserOrgIds = () => {
        const orgIds = new Set();
        // Direct org assignment
        if (user?.organizationId) orgIds.add(user.organizationId);
        // Group-based detection (fallback)
        const myGroups = user?.groups || [];
        for (const gid of myGroups) {
            const group = groups.find(g => g.id === gid);
            if (group?.organizationId) orgIds.add(group.organizationId);
        }
        return orgIds;
    };

    const userOrgIds = getUserOrgIds();
    const orgGroups = groups.filter(g => g.organizationId && userOrgIds.has(g.organizationId));
    // The tab badge counts the roles the tab LISTS. It used to filter the
    // system-role table down to three hardcoded ids and count those, so the
    // header read "Roles 3" above a list of six — the DPO, the ISMS auditor and
    // the Member were listed but never counted.
    const orgRoleCount = ORG_ROLES.length;

    // Only an org admin may reshape what a role grants — the server refuses
    // the PUT for anyone else, so offering the toggles would be a lie.
    const canEditRoles = !!(user?.isAdmin || ['org_admin', 'admin'].includes(user?.orgRole));

    // Splice one saved role back into the mapping so the chips above the
    // editor update without re-fetching the whole panel.
    const handleRolePermissionsSaved = (roleId, permissions) => {
        setOrgRolePerms(prev => prev.map(r => (r.id === roleId
            ? {
                id: r.id,
                // The server returns only the editable half; everything else
                // the role carries is untouched by the save.
                permissions: [
                    ...r.permissions.filter(p => !editablePermissions.includes(p)),
                    ...permissions,
                ],
            }
            : r)));
    };

    // Trust the server's org scoping. GET /auth/users already returns exactly
    // the org members the caller may see (scoped server-side via
    // resolveUserOrgIds, self always included). Re-deriving the org set on the
    // client from `user.organizationId` caused the member list to diverge
    // between the embedded Nextcloud view and standalone, and could hide
    // members from an org-admin whose client-side org pointer was stale. We
    // only drop system rows here.
    const orgUsers = users.filter(u => !u.isSystem);

    // Filter state + filtering live in the shared hook, so this panel and the
    // Security People directory cannot drift apart. This panel is already scoped
    // to one org, so it uses neither the `org` nor the `via` axis.
    const {
        filters: userFilters,
        setFilter: setUserFilter,
        clear: clearUserFilters,
        active: userFiltersActive,
        filtered: filteredOrgUsers,
    } = useUserFilters(orgUsers, { groups });


    const getRoleBadge = (role) => <RoleBadge role={role} />;

    // Count users with a specific role
    const getUsersWithRole = (roleId) => {
        return users.filter(u => u.orgRole === roleId && !u.isSystem).length;
    };

    if (loading) {
        return (
            <div className="max-w-4xl mx-auto space-y-6">
                <div className="flex gap-2">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-10 w-28 bg-[var(--bg-tertiary)] rounded-xl animate-pulse" />
                    ))}
                </div>
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
                    <UserListSkeleton />
                </div>
            </div>
        );
    }

    const isNcOrg = !!user?.ncOrg?.instanceId;
    const sections = [
        { id: 'users', label: 'Users', icon: Users, count: orgUsers.length },
        { id: 'groups', label: 'Groups', icon: UserPlus, count: orgGroups.length },
        { id: 'roles', label: 'Roles', icon: Shield, count: orgRoleCount },
        ...(isNcOrg ? [{ id: 'sync', label: 'Nextcloud Sync', icon: Cloud, count: null }] : []),
    ];

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            {/* Section tabs */}
            <div className="flex gap-2">
                {sections.map(s => (
                    <button
                        key={s.id}
                        onClick={() => setActiveSection(s.id)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${activeSection === s.id
                            ? 'bg-[var(--accent-primary)] text-white shadow-md'
                            : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                            }`}
                    >
                        <s.icon className="w-4 h-4" />
                        {s.label}
                        {s.count != null && (
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${activeSection === s.id ? 'bg-white/20' : 'bg-white/10'}`}>
                                {s.count}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* ═══════════════ USERS SECTION ═══════════════ */}
            {activeSection === 'users' && (
                <>
                {/* Connector-health blockers (pending approvals / org-level
                    blocks). Renders null for healthy or non-connector orgs. */}
                <OrgHealthBanner />
                {/* Auto-approve toggle — only meaningful when the org's sign-in
                    method is an external provider (Google/Microsoft). */}
                {orgAuthMethod && orgAuthMethod !== 'password' && (
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 mb-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <Users className="w-4 h-4 text-[var(--accent-primary)]" />
                                    <span className="text-sm font-semibold text-[var(--text-primary)]">{t('org.auto_approve_sso')}</span>
                                </div>
                                <p className="text-xs text-[var(--text-muted)] mt-1 ml-6">
                                    {t('org.auto_approve_desc')}
                                </p>
                            </div>
                            <button
                                onClick={handleToggleAutoApprove}
                                disabled={savingAutoApprove}
                                className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${autoApprove ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'} ${savingAutoApprove ? 'opacity-60 cursor-wait' : ''}`}
                            >
                                <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${autoApprove ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                            </button>
                        </div>
                    </div>
                )}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                    <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] rounded-t-xl flex items-center justify-between">
                        <div>
                            <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin.org_members_title', 'Organisation Members')}</h3>
                            <p className="text-xs text-[var(--text-muted)] mt-0.5">{t('admin.org_members_desc', 'Manage roles and group assignments for users in your organisation')}</p>
                        </div>
                        <button
                            onClick={() => { setShowInviteForm(v => !v); setInviteResult(null); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity"
                        >
                            <Send className="w-3.5 h-3.5" />
                            {t('admin.org_invite_user', 'Invite User')}
                        </button>
                    </div>

                    {/* Invite form */}
                    {showInviteForm && (
                        <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--accent-primary)]/5">
                            <div className="flex items-end gap-3">
                                <div className="flex-1">
                                    <label className="block text-[10px] font-medium text-[var(--text-muted)] mb-1 uppercase tracking-wider">{t('admin_org.users_email_address', 'Email Address')}</label>
                                    <input
                                        type="email"
                                        value={inviteEmail}
                                        onChange={e => setInviteEmail(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && handleSendInvite()}
                                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent-primary)] transition-colors"
                                        placeholder="colleague@example.com"
                                        autoFocus
                                    />
                                </div>
                                <div className="w-40">
                                    <label className="block text-[10px] font-medium text-[var(--text-muted)] mb-1 uppercase tracking-wider">{t('admin_org.users_role', 'Role')}</label>
                                    <select
                                        value={inviteRole}
                                        onChange={e => setInviteRole(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none"
                                    >
                                        <option value="user">{t('admin_org.users_user', 'User')}</option>
                                        {ORG_ROLES.map(r => (
                                            <option key={r.id} value={r.id}>{r.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <button
                                    onClick={handleSendInvite}
                                    disabled={sendingInvite || !inviteEmail.trim()}
                                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                                >
                                    {sendingInvite ? (
                                        <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <Send className="w-3.5 h-3.5" />
                                    )}
                                    {t('admin_org.users_send', 'Send')}
                                </button>
                            </div>
                            {inviteResult && (
                                <div className={`mt-3 flex items-start gap-2 text-xs px-3 py-2 rounded-lg ${inviteResult.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                                    {inviteResult.success ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                                    <div>
                                        <span>{inviteResult.message}</span>
                                        {inviteResult.inviteUrl && (
                                            <button
                                                onClick={() => { navigator.clipboard.writeText(inviteResult.inviteUrl); }}
                                                className="flex items-center gap-1 mt-1 text-[var(--accent-primary)] hover:underline"
                                            >
                                                <Link2 className="w-3 h-3" />
                                                {t('admin_org.users_copy_invite', 'Copy invite link')}
                                            </button>
                                        )}
                                        {/* BFSF-251: seat cap → direct upgrade path, no dead end */}
                                        {inviteResult.upgradeLink && (
                                            <a
                                                href="/app/settings/organisation/license"
                                                className="flex items-center gap-1 mt-1 font-semibold text-[var(--accent-primary)] hover:underline"
                                            >
                                                {t('agent_wizard.view_plans', 'View plans & upgrade')}
                                            </a>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                    {orgUsers.length === 0 ? (
                        <div className="px-5 py-12 text-center">
                            <Users className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-30" />
                            <p className="text-sm font-medium text-[var(--text-primary)]">{t('admin.org_no_users', 'No users yet')}</p>
                            <p className="text-xs text-[var(--text-muted)] mt-1 max-w-sm mx-auto">
                                {t('admin.org_no_users_desc', 'Users will appear here once they are assigned to your organisation. Add users via the admin panel or invite them by sharing a signup link.')}
                            </p>
                            <div className="flex items-center justify-center gap-3 mt-4">
                                <button
                                    onClick={() => setActiveSection('groups')}
                                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity"
                                >
                                    <UserPlus className="w-4 h-4" />
                                    {t('admin_org.users_manage_groups', 'Manage Groups')}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <UserFilterBar
                                filters={userFilters}
                                setFilter={setUserFilter}
                                clear={clearUserFilters}
                                active={userFiltersActive}
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
                            {filteredOrgUsers.map(u => {
                                const uGroups = Array.isArray(u.groups) ? u.groups : [];
                                const userOrgGroups = orgGroups.filter(g => uGroups.includes(g.id));
                                return (
                                    <div key={u.id} className="px-5 py-3 flex items-center gap-4 hover:bg-[var(--bg-secondary)] transition-colors">
                                        {/* Avatar */}
                                        {u.avatarType === 'emoji' && u.avatar ? (
                                            <div className="w-9 h-9 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center text-lg shrink-0">
                                                {u.avatar}
                                            </div>
                                        ) : (u.avatarType === 'image' || u.avatarType === 'url') && u.avatar ? (
                                            <img src={u.avatar.startsWith('/') ? `${API_BASE}${u.avatar}` : u.avatar} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
                                        ) : u.avatar && (u.avatar.startsWith('http') || u.avatar.startsWith('/')) ? (
                                            <img src={u.avatar.startsWith('/') ? `${API_BASE}${u.avatar}` : u.avatar} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
                                        ) : (
                                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
                                                {(u.displayName || u.username || '?')[0].toUpperCase()}
                                            </div>
                                        )}
                                        {/* Info */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium text-[var(--text-primary)] truncate">{u.displayName || u.username}</span>
                                                {u.status === 'pending' ? (
                                                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-500 flex items-center gap-1">
                                                        <Clock className="w-2.5 h-2.5" />
                                                        {t('admin_org.users_pending', 'Pending')}
                                                    </span>
                                                ) : (
                                                    getRoleBadge(u.orgRole || u.role)
                                                )}
                                            </div>
                                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                {u.email && (
                                                    <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                                                        <Mail className="w-2.5 h-2.5" />
                                                        {u.email}
                                                    </span>
                                                )}
                                                {userOrgGroups.map(g => (
                                                    <span key={g.id} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                                                        {g.name}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        {/* AI cost — last 30 days */}
                                        {(() => {
                                            const usage = usageByUser.get(u.id);
                                            if (!usage || !usage.cost) return null;
                                            const cost = usage.cost;
                                            const display = cost >= 100 ? `$${cost.toFixed(0)}` : cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
                                            return (
                                                <div
                                                    className="hidden md:flex flex-col items-end shrink-0 text-right"
                                                    title={t('admin.org_usage_tooltip', { calls: usage.calls.toLocaleString(), cost: `$${cost.toFixed(4)}` })}
                                                >
                                                    <span className="text-[11px] font-semibold text-[var(--text-primary)] leading-tight">{display}</span>
                                                    <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider leading-tight">{t('admin.org_usage_cost_30d')}</span>
                                                </div>
                                            );
                                        })()}
                                        {u.status === 'pending' ? (
                                            <div className="flex items-center gap-1">
                                                <button
                                                    onClick={() => handleApproveUser(u.id)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
                                                    title={t('admin_org.users_approve_title', 'Approve user')}
                                                >
                                                    <Check className="w-3.5 h-3.5" />
                                                    {t('admin.org_approve', 'Approve')}
                                                </button>
                                                <button
                                                    onClick={() => handleRejectUser(u.id)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                                                    title={t('admin_org.users_reject_title', 'Reject user')}
                                                >
                                                    <X className="w-3.5 h-3.5" />
                                                    {t('admin.org_reject', 'Reject')}
                                                </button>
                                            </div>
                                        ) : (
                                            <>
                                                {/* Role dropdown */}
                                                <div className="relative">
                                                    {editingUserRole === u.id ? (
                                                        <div className="flex items-center gap-1">
                                                            <select
                                                                defaultValue={u.orgRole || 'user'}
                                                                onChange={e => handleUserRoleChange(u.id, e.target.value)}
                                                                className="text-xs px-2 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none"
                                                            >
                                                                <option value="user">{t('admin_org.users_user', 'User')}</option>
                                                                {ORG_ROLES.map(r => (
                                                                    <option key={r.id} value={r.id}>{r.name}</option>
                                                                ))}
                                                            </select>
                                                            <button onClick={() => setEditingUserRole(null)} className="p-1 rounded hover:bg-white/10 text-[var(--text-muted)]">
                                                                <X className="w-3.5 h-3.5" />
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => setEditingUserRole(u.id)}
                                                            className="text-xs px-2 py-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                                                            title={t('admin_org.users_change_role', 'Change role')}
                                                        >
                                                            <Edit2 className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                </div>
                                                {/* Group assignment — click-to-open popover */}
                                                <div className="relative" ref={groupAssignOpenFor === u.id ? groupAssignRef : null}>
                                                    <button
                                                        onClick={() => {
                                                            setGroupAssignOpenFor(prev => prev === u.id ? null : u.id);
                                                            setGroupAssignSearch('');
                                                        }}
                                                        className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg transition-colors ${groupAssignOpenFor === u.id
                                                            ? 'bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]'
                                                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}`}
                                                        title={t('admin.org_assign_groups', 'Assign groups')}
                                                    >
                                                        <UserPlus className="w-3.5 h-3.5" />
                                                        {uGroups.length > 0 && (
                                                            <span className="text-[10px] font-semibold">{uGroups.length}</span>
                                                        )}
                                                    </button>
                                                    {groupAssignOpenFor === u.id && (
                                                        <div className="absolute right-0 top-full mt-1 w-64 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-xl z-50">
                                                            <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between">
                                                                <div className="text-xs font-semibold text-[var(--text-primary)]">{t('admin.org_assign_groups_title', 'Groups')}</div>
                                                                <span className="text-[10px] text-[var(--text-muted)]">
                                                                    {t('admin.org_assign_groups_selected', '{count} selected').replace('{count}', uGroups.length)}
                                                                </span>
                                                            </div>
                                                            {orgGroups.length > 5 && (
                                                                <div className="px-2 pt-2">
                                                                    <div className="relative">
                                                                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-muted)]" />
                                                                        <input
                                                                            type="text"
                                                                            autoFocus
                                                                            value={groupAssignSearch}
                                                                            onChange={e => setGroupAssignSearch(e.target.value)}
                                                                            placeholder={t('admin.org_assign_groups_search', 'Search groups…')}
                                                                            className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs outline-none focus:border-[var(--accent-primary)]"
                                                                        />
                                                                    </div>
                                                                </div>
                                                            )}
                                                            <div className="max-h-60 overflow-auto p-1">
                                                                {orgGroups.length === 0 ? (
                                                                    <div className="px-3 py-4 text-center">
                                                                        <div className="text-xs text-[var(--text-muted)] mb-2">{t('admin.org_assign_groups_none', 'No groups in this organisation yet.')}</div>
                                                                        <button
                                                                            onClick={() => { setGroupAssignOpenFor(null); setActiveSection('groups'); setShowCreateGroup(true); }}
                                                                            className="inline-flex items-center gap-1 text-[11px] text-[var(--accent-primary)] hover:underline"
                                                                        >
                                                                            <Plus className="w-3 h-3" />
                                                                            {t('admin.org_new_group', 'Create New Group')}
                                                                        </button>
                                                                    </div>
                                                                ) : (() => {
                                                                    const q = groupAssignSearch.trim().toLowerCase();
                                                                    const matches = q ? orgGroups.filter(g => (g.name || '').toLowerCase().includes(q)) : orgGroups;
                                                                    // Selected first, then alphabetical within each segment.
                                                                    const sorted = [...matches].sort((a, b) => {
                                                                        const aSel = uGroups.includes(a.id) ? 0 : 1;
                                                                        const bSel = uGroups.includes(b.id) ? 0 : 1;
                                                                        if (aSel !== bSel) return aSel - bSel;
                                                                        return (a.name || '').localeCompare(b.name || '');
                                                                    });
                                                                    if (sorted.length === 0) {
                                                                        return <div className="px-3 py-3 text-[11px] text-[var(--text-muted)] text-center">{t('admin.org_assign_groups_no_match', 'No groups match your search.')}</div>;
                                                                    }
                                                                    return sorted.map(g => {
                                                                        const isMember = uGroups.includes(g.id);
                                                                        const memberCount = getGroupCount(g.id);
                                                                        return (
                                                                            <button
                                                                                key={g.id}
                                                                                type="button"
                                                                                onClick={() => handleUserGroupToggle(u.id, g.id, uGroups)}
                                                                                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left cursor-pointer text-sm transition-colors ${isMember ? 'bg-[var(--accent-primary)]/10 hover:bg-[var(--accent-primary)]/15' : 'hover:bg-[var(--bg-secondary)]'}`}
                                                                            >
                                                                                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isMember ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)]' : 'border-[var(--border-subtle)]'}`}>
                                                                                    {isMember && <Check className="w-3 h-3 text-white" />}
                                                                                </span>
                                                                                <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{g.name}</span>
                                                                                <span className="text-[10px] text-[var(--text-muted)]">{memberCount}</span>
                                                                            </button>
                                                                        );
                                                                    });
                                                                })()}
                                                            </div>
                                                            {orgGroups.length > 0 && (
                                                                <div className="px-2 py-1.5 border-t border-[var(--border-subtle)]">
                                                                    <button
                                                                        onClick={() => { setGroupAssignOpenFor(null); setActiveSection('groups'); setShowCreateGroup(true); }}
                                                                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/5 transition-colors"
                                                                    >
                                                                        <Plus className="w-3 h-3" />
                                                                        {t('admin.org_new_group', 'Create New Group')}
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                            )}
                        </>
                    )}

                    {/* Pending Invitations */}
                    {invitations.filter(i => i.status === 'pending').length > 0 && (
                        <div className="border-t border-[var(--border-subtle)]">
                            <div className="px-5 py-3 bg-[var(--bg-secondary)]">
                                <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">{t('admin_org.users_pending_invitations', 'Pending Invitations')}</h4>
                            </div>
                            <div className="divide-y divide-[var(--border-subtle)]">
                                {invitations.filter(i => i.status === 'pending').map(inv => (
                                    <div key={inv.id} className="px-5 py-2.5 flex items-center gap-4">
                                        <div className="w-9 h-9 rounded-full bg-[var(--accent-primary)]/10 flex items-center justify-center shrink-0">
                                            <Mail className="w-4 h-4 text-[var(--accent-primary)]" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium text-[var(--text-primary)] truncate">{inv.email}</span>
                                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-500 flex items-center gap-1">
                                                    <Clock className="w-2.5 h-2.5" />
                                                    {t('admin_org.users_invited', 'Invited')}
                                                </span>
                                                {inv.role && inv.role !== 'user' && getRoleBadge(inv.role)}
                                            </div>
                                            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                                                {t('admin_org.users_invited_by', 'Invited by {name} · Expires {date}', { name: inv.inviterName || t('admin_org.users_unknown', 'Unknown'), date: new Date(inv.expires_at).toLocaleDateString() })}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleRevokeInvite(inv.id)}
                                            className="text-xs px-2 py-1 rounded-lg text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                            title={t('admin_org.users_revoke_invite', 'Revoke invitation')}
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                </>
            )}

            {/* ═══════════════ GROUPS SECTION ═══════════════ */}
            {activeSection === 'groups' && (
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
                            {orgGroups.map(group => {
                                const count = getGroupCount(group.id);
                                const isSystem = group.id === 'admins' || group.id === 'users';
                                return (
                                    <div key={group.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] transition-all" style={{ borderColor: expandedGroup === group.id ? 'var(--border-default)' : undefined }}>
                                        <div className="flex items-start justify-between gap-3 p-4 cursor-pointer" onClick={() => setExpandedGroup(expandedGroup === group.id ? null : group.id)}>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    {expandedGroup === group.id ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
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
                                                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                                    {group.description || t('admin_org.users_no_description', 'No description')}
                                                    {group.orgRole && (() => {
                                                        const role = ORG_ROLES.find(r => r.id === group.orgRole);
                                                        return role ? (
                                                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded text-white font-medium" style={{ background: role.color }}>
                                                                {role.name}
                                                            </span>
                                                        ) : null;
                                                    })()}
                                                    {group.source === 'azure' && group.lastSyncedAt && (
                                                        <span className="ml-2 text-[10px] text-[var(--text-muted)] opacity-60">{t('admin_org.users_last_synced', 'Last synced: {date}', { date: new Date(group.lastSyncedAt).toLocaleString() })}</span>
                                                    )}
                                                </p>
                                            </div>
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
                                        </div>
                                        {/* Expanded member list */}
                                        {expandedGroup === group.id && (
                                            <div className="border-t border-[var(--border-subtle)] px-4 py-3 space-y-4">
                                                {/* Group settings */}
                                                <div className="space-y-3">
                                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                                                        {t('admin.org_group_settings', 'Group Settings')}
                                                    </p>

                                                    {/* Description */}
                                                    <div className="flex items-start gap-2">
                                                        <label className="text-xs text-[var(--text-secondary)] w-24 pt-1.5 shrink-0">{t('admin_org.users_description', 'Description')}</label>
                                                        {editingGroup === group.id ? (
                                                            <div className="flex items-center gap-2 flex-1">
                                                                <input
                                                                    type="text"
                                                                    value={editGroupDesc}
                                                                    onChange={e => setEditGroupDesc(e.target.value)}
                                                                    className="flex-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs outline-none focus:border-blue-500"
                                                                    placeholder={t('admin_org.users_add_desc_ph', 'Add a description...')}
                                                                    onKeyDown={e => e.key === 'Enter' && handleUpdateGroupDesc(group.id)}
                                                                    autoFocus
                                                                />
                                                                <button onClick={() => handleUpdateGroupDesc(group.id)} className="p-1 text-green-500 hover:bg-green-500/10 rounded">
                                                                    <Check className="w-3.5 h-3.5" />
                                                                </button>
                                                                <button onClick={() => setEditingGroup(null)} className="p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] rounded">
                                                                    <X className="w-3.5 h-3.5" />
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-[var(--text-muted)] pt-1.5 flex-1 cursor-pointer hover:text-[var(--text-primary)] transition-colors"
                                                                onClick={(e) => { e.stopPropagation(); setEditingGroup(group.id); setEditGroupDesc(group.description || ''); }}>
                                                                {group.description || <span className="italic opacity-60">{t('admin_org.users_click_add_desc', 'Click to add description...')}</span>}
                                                            </p>
                                                        )}
                                                    </div>

                                                    {/* Role selector */}
                                                    <div className="flex items-center gap-2">
                                                        <label className="text-xs text-[var(--text-secondary)] w-24 shrink-0">{t('admin_org.users_group_role', 'Group Role')}</label>
                                                        <select
                                                            value={group.orgRole || ''}
                                                            onChange={e => handleUpdateGroupRole(group.id, e.target.value)}
                                                            className="flex-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs outline-none focus:border-blue-500 cursor-pointer"
                                                        >
                                                            <option value="">{t('admin_org.users_user_default', 'User (default)')}</option>
                                                            {ORG_ROLES.map(r => (
                                                                <option key={r.id} value={r.id}>{r.name}</option>
                                                            ))}
                                                        </select>
                                                        {group.orgRole && (
                                                            <span className="text-[10px] text-[var(--text-muted)]">
                                                                {t('admin_org.users_inherit_role', 'All members inherit this role')}
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* Allowed tiers — standard + custom. Empty array = no restriction (all tiers). */}
                                                    {(() => {
                                                        const allowed = Array.isArray(group.allowedTiers) ? group.allowedTiers : [];
                                                        const standardTiers = [
                                                            { id: 'fast', label: 'Fast', icon: '⚡' },
                                                            { id: 'thinking', label: 'Thinking', icon: '🧠' },
                                                            { id: 'writer', label: 'Writer', icon: '✍️' },
                                                            { id: 'pro', label: 'Deep Thinking', icon: '✨' },
                                                        ];
                                                        const unrestricted = allowed.length === 0;
                                                        const toggleTier = (tierId) => {
                                                            const set = new Set(allowed);
                                                            if (set.has(tierId)) set.delete(tierId);
                                                            else set.add(tierId);
                                                            handleUpdateGroupAllowedTiers(group.id, Array.from(set));
                                                        };
                                                        const clearAll = () => handleUpdateGroupAllowedTiers(group.id, []);
                                                        const renderPill = (t, accent) => {
                                                            // When unrestricted, render pills muted as inactive so clicking
                                                            // feels like "selecting this one tier to restrict to" rather than
                                                            // deselecting from an all-selected state.
                                                            const active = !unrestricted && allowed.includes(t.id);
                                                            return (
                                                                <button
                                                                    key={t.id}
                                                                    type="button"
                                                                    onClick={() => toggleTier(t.id)}
                                                                    className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                                                                    style={{
                                                                        background: active ? accent : 'var(--bg-primary)',
                                                                        color: active ? '#fff' : 'var(--text-muted)',
                                                                        border: `1px solid ${active ? accent : 'var(--border-subtle)'}`,
                                                                    }}
                                                                    title={t.description || ''}
                                                                >
                                                                    {t.icon || '✨'} {t.label || t.id}
                                                                </button>
                                                            );
                                                        };
                                                        return (
                                                            <div className="flex items-start gap-2">
                                                                <label className="text-xs text-[var(--text-secondary)] w-24 pt-1.5 shrink-0">{t('admin_org.users_allowed_tiers', 'Allowed tiers')}</label>
                                                                <div className="flex-1 space-y-2">
                                                                    <div className="flex flex-wrap gap-1.5">
                                                                        {standardTiers.map(t => renderPill(t, 'rgb(59, 130, 246)'))}
                                                                        {customTiersMeta.map(t => renderPill(t, 'rgb(234, 179, 8)'))}
                                                                    </div>
                                                                    <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-3">
                                                                        {unrestricted ? (
                                                                            <span>{t('admin_org.users_no_restriction', 'No restriction set: members can use every tier. Click a pill to restrict access to only selected tiers.')}</span>
                                                                        ) : (
                                                                            <>
                                                                                <span>{allowed.length === 1 ? t('admin_org.users_tier_permitted_one', '{n} tier permitted. Members of other groups may still see additional tiers through those groups.', { n: allowed.length }) : t('admin_org.users_tier_permitted_other', '{n} tiers permitted. Members of other groups may still see additional tiers through those groups.', { n: allowed.length })}</span>
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={clearAll}
                                                                                    className="underline hover:text-[var(--text-primary)]"
                                                                                >
                                                                                    {t('admin_org.users_clear_restrictions', 'Clear restrictions')}
                                                                                </button>
                                                                            </>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })()}
                                                </div>

                                                {/* Add member directly from the group view (BFSF-219). */}
                                                <div className="mb-3">
                                                    {memberAddGroupId === group.id ? (
                                                        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-2">
                                                            <input
                                                                autoFocus
                                                                value={memberAddSearch}
                                                                onChange={e => setMemberAddSearch(e.target.value)}
                                                                placeholder={t('admin.org_group_add_member_search', 'Search users to add…')}
                                                                className="w-full px-2.5 py-1.5 rounded-md border text-xs outline-none mb-1.5"
                                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                                                            />
                                                            <div className="max-h-40 overflow-y-auto space-y-1">
                                                                {(() => {
                                                                    const candidates = orgUsers
                                                                        .filter(u => !(Array.isArray(u.groups) ? u.groups : []).includes(group.id))
                                                                        .filter(u => group.organizationId ? u.organizationId === group.organizationId : true);
                                                                    const q = memberAddSearch.trim().toLowerCase();
                                                                    const shown = candidates.filter(u => !q
                                                                        || (u.displayName || '').toLowerCase().includes(q)
                                                                        || (u.username || '').toLowerCase().includes(q)
                                                                        || (u.email || '').toLowerCase().includes(q)).slice(0, 20);
                                                                    if (candidates.length === 0) {
                                                                        return <p className="text-[11px] text-[var(--text-muted)] text-center py-1.5">{t('admin.org_group_all_added', 'Everyone is already a member')}</p>;
                                                                    }
                                                                    return shown.map(u => (
                                                                        <button key={u.id} disabled={memberBusy} onClick={() => addGroupMember(group.id, u.id)}
                                                                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-left disabled:opacity-50">
                                                                            <span className="text-xs font-medium text-[var(--text-primary)] truncate">{u.displayName || u.username}</span>
                                                                            {u.email && <span className="text-[10px] text-[var(--text-muted)] truncate">{u.email}</span>}
                                                                            <Plus className="w-3 h-3 ml-auto text-[var(--text-muted)] shrink-0" />
                                                                        </button>
                                                                    ));
                                                                })()}
                                                            </div>
                                                            <button onClick={() => { setMemberAddGroupId(null); setMemberAddSearch(''); }} className="mt-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                                                                {t('common.close', 'Close')}
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button onClick={() => { setMemberAddGroupId(group.id); setMemberAddSearch(''); }}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed hover:bg-[var(--bg-tertiary)]"
                                                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                                                            <Plus className="w-3.5 h-3.5" /> {t('admin.org_group_add_member', 'Add member')}
                                                        </button>
                                                    )}
                                                </div>

                                                {/* Members list */}
                                                {(() => {
                                                    const members = getGroupMembers(group.id);
                                                    if (members.length === 0) {
                                                        return (
                                                            <p className="text-xs text-[var(--text-muted)] text-center py-2">
                                                                {t('admin.org_group_no_members', 'No members in this group')}
                                                            </p>
                                                        );
                                                    }
                                                    return (
                                                        <div className="space-y-1.5">
                                                            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                                                                {t('admin.org_group_members', 'Members')} ({members.length})
                                                            </p>
                                                            {members.map(m => (
                                                                <div key={m.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--bg-primary)]">
                                                                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                                                                        style={{ background: `hsl(${(m.displayName || m.username || '').charCodeAt(0) * 37 % 360}, 55%, 50%)` }}>
                                                                        {(m.displayName || m.username || '?').charAt(0).toUpperCase()}
                                                                    </div>
                                                                    <div className="flex-1 min-w-0">
                                                                        <p className="text-xs font-medium text-[var(--text-primary)] truncate">{m.displayName || m.username}</p>
                                                                        {m.email && (
                                                                            <p className="text-[10px] text-[var(--text-muted)] truncate flex items-center gap-1">
                                                                                <Mail className="w-2.5 h-2.5" />
                                                                                {m.email}
                                                                            </p>
                                                                        )}
                                                                    </div>
                                                                    <div className="shrink-0">
                                                                        {getRoleBadge(group.orgRole || m.role || m.orgRole)}
                                                                    </div>
                                                                    <button
                                                                        disabled={memberBusy}
                                                                        onClick={() => removeGroupMember(group.id, m.id)}
                                                                        title={t('admin.org_group_remove_member', 'Remove from group')}
                                                                        className="shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:text-red-500 hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                                                                    >
                                                                        <X className="w-3.5 h-3.5" />
                                                                    </button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ═══════════════ ROLES SECTION ═══════════════ */}
            {activeSection === 'roles' && (
                <div className="space-y-3">
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
                        <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                            <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin.org_roles_title', 'Organisation Roles')}</h3>
                            <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                {t('admin.org_roles_desc', 'These roles define what members can do within your organisation. Assign roles in the Users tab.')}
                            </p>
                        </div>
                        <div className="divide-y divide-[var(--border-subtle)]">
                            {ORG_ROLES.map(role => {
                                const isExpanded = expandedRole === role.id;
                                const assignedCount = getUsersWithRole(role.id);
                                const rolePermissions = permissionsForRole(role.id, orgRolePerms);
                                return (
                                    <div key={role.id} className="group">
                                        <button
                                            onClick={() => setExpandedRole(isExpanded ? null : role.id)}
                                            className="w-full px-5 py-4 flex items-start gap-4 text-left hover:bg-[var(--bg-secondary)] transition-colors"
                                        >
                                            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${role.color}15` }}>
                                                <Shield className="w-5 h-5" style={{ color: role.color }} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-semibold text-[var(--text-primary)]">{role.name}</span>
                                                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white" style={{ background: role.color }}>
                                                        {role.id}
                                                    </span>
                                                    {assignedCount > 0 && (
                                                        <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                                                            <Users className="w-2.5 h-2.5" />
                                                            {assignedCount} {assignedCount === 1 ? 'user' : 'users'}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">{role.description}</p>

                                                {/* Permission badges - always visible. Chips are
                                                    tinted with the role's own colour rather than a
                                                    three-role lookup that left dpo, isms_auditor and
                                                    member with unstyled chips. */}
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {rolePermissions.map(p => (
                                                        <span
                                                            key={p.id}
                                                            className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                                                            style={{ background: `${role.color}26`, color: role.color }}
                                                        >
                                                            {p.label}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                            <div className="shrink-0 mt-1">
                                                {isExpanded
                                                    ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
                                                    : <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                                                }
                                            </div>
                                        </button>

                                        {/* Expanded permission details + the org's own switches */}
                                        {isExpanded && (
                                            <RolePermissionEditor
                                                role={role}
                                                mapping={orgRolePerms}
                                                editablePermissions={editablePermissions}
                                                canEdit={canEditRoles}
                                                onSaved={handleRolePermissionsSaved}
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* ═══════════════ CUSTOM TIERS SECTION ═══════════════ */}
            {activeSection === 'customTiers' && (
                <OrgCustomTiersPanel />
            )}

            {/* ═══════════════ NEXTCLOUD SYNC SECTION ═══════════════ */}
            {activeSection === 'sync' && isNcOrg && (
                <NextcloudSyncPanel user={user} />
            )}

            {/* A refused role change — most often "this would leave the
                organisation without an administrator", which no in-app route
                could undo. Silence here used to leave the dropdown showing a
                role that was never saved. */}
            {roleChangeError && (
                <div className="flex items-start gap-2 rounded-xl p-3 text-sm"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--error)' }} />
                    <span>{roleChangeError}</span>
                    <button type="button" onClick={() => setRoleChangeError('')} className="ml-auto shrink-0">
                        <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                    </button>
                </div>
            )}

            {confirmDialog}
            <ConfirmDialog
                open={!!pendingSelfDemotion}
                title={t('admin.sec_self_demote_title', 'Give up your admin rights?')}
                description={pendingSelfDemotion?.message
                    || t('admin.sec_self_demote_desc', 'This removes your own administrator rights over this organisation. Another administrator would have to give them back.')}
                confirmLabel={t('admin.sec_self_demote_confirm', 'Yes, step down')}
                cancelLabel={t('admin.sec_cancel', 'Cancel')}
                destructive
                onConfirm={() => {
                    const p = pendingSelfDemotion;
                    setPendingSelfDemotion(null);
                    if (p) handleUserRoleChange(p.userId, p.newRole, { confirmSelfDemotion: true });
                }}
                onCancel={() => setPendingSelfDemotion(null)}
            />
        </div>
    );
};

export default OrgUsersPanel;
