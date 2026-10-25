import { Users, UserPlus, Shield, X, AlertCircle } from 'lucide-react';
import { useState } from 'react';
import OrgCustomTiersPanel from './OrgCustomTiersPanel';
import GroupsSection from './orgUsers/GroupsSection';
import RolesSection from './orgUsers/RolesSection';
import UsersSection from './orgUsers/UsersSection';
import useOrgDirectory from './useOrgDirectory';
import type { OrgGroupRow, OrgRolePermissions } from './useOrgDirectory';
import useOrgGroups from './useOrgGroups';
import useOrgInvitations from './useOrgInvitations';
import useOrgMemberRoles from './useOrgMemberRoles';
import type { OrgMemberRoles } from './useOrgMemberRoles';
import { ORG_ROLES } from '../../../config/orgRoles';
import { useTranslation } from '../../../hooks/useTranslation';
import { useUrlTab } from '../../../hooks/useUrlTab';
import { useUserFilters } from '../../../hooks/useUserFilters';
import NextcloudSyncPanel from '../../integrations/nextcloud/NextcloudSyncPanel';
import ConfirmDialog from '../../shared/ConfirmDialog';
import Tabs from '../../shared/Tabs';
import useConfirm from '../../shared/useConfirm';
import UserListSkeleton from '../../shared/UserListSkeleton';

// The sub-tabs map to <basePath>/{list|groups|roles}. basePath is the address
// of the screen that mounts this panel: Settings → Organisation → Users & Groups
// passes /app/settings/organisation/users, and the legacy page at
// /app/org-settings keeps the default. With one hard-coded base, a click on
// Groups inside Settings pushed /app/org-settings/users/groups, and a reload
// opened the legacy page instead of Settings.
// The 'list' URL corresponds to the 'users' internal id so the URL segment
// doesn't collide with the parent path (`.../users`).
// 'customTiers' and 'sync' have no tab but keep their address: bookmarks, the
// phone app and a Learning Center lesson open them directly. Nextcloud Sync's
// tab went because Settings → Organisation → Nextcloud Sync (and the legacy
// page's own Nextcloud Sync tab) shows the same panel to everyone who saw it.
const ORG_USERS_SECTIONS = ['users', 'groups', 'roles', 'customTiers', 'sync'];
const ORG_USERS_URL_ALIASES = { users: 'list' };
const LEGACY_BASE_PATH = '/app/org-settings/users';

/** The signed-in member, as far as this panel reads them. */
interface OrgUsersPanelUser {
    organizationId?: string | null;
    /** Group ids. */
    groups?: string[];
    isAdmin?: boolean;
    orgRole?: string | null;
    ncOrg?: { instanceId?: string | null } | null;
    [key: string]: unknown;
}

interface OrgUsersPanelProps {
    user?: OrgUsersPanelUser | null;
    initialSection?: string;
    basePath?: string;
}

/** Resolve org IDs from the user's direct assignment and their groups. */
function getUserOrgIds(user: OrgUsersPanelUser | null | undefined, groups: OrgGroupRow[]): Set<string> {
    const orgIds = new Set<string>();
    // Direct org assignment
    if (user?.organizationId) orgIds.add(user.organizationId);
    // Group-based detection (fallback)
    const myGroups = user?.groups || [];
    for (const gid of myGroups) {
        const group = groups.find(g => g.id === gid);
        if (group?.organizationId) orgIds.add(group.organizationId);
    }
    return orgIds;
}

/**
 * Splice one saved role back into the mapping so the chips above the editor
 * update without re-fetching the whole panel. The server returns only the
 * editable half; everything else the role carries is untouched by the save.
 */
function spliceRolePermissions(prev: OrgRolePermissions[], roleId: string, permissions: string[], editable: string[]): OrgRolePermissions[] {
    return prev.map(r => (r.id === roleId
        ? { id: r.id, permissions: [...r.permissions.filter(p => !editable.includes(p)), ...permissions] }
        : r));
}

function PanelSkeleton() {
    return (
        <div className="max-w-4xl space-y-6">
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

/**
 * A refused role change — most often "this would leave the organisation
 * without an administrator", which no in-app route could undo. Silence here
 * used to leave the dropdown showing a role that was never saved.
 */
function RoleChangeErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return (
        <div className="flex items-start gap-2 rounded-xl p-3 text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 [color:var(--error)]" />
            <span>{message}</span>
            <button type="button" onClick={onDismiss} className="ml-auto shrink-0">
                <X className="w-4 h-4 text-[var(--text-muted)]" />
            </button>
        </div>
    );
}

/** A self-demotion the server asked to confirm; confirming re-sends the change deliberately. */
function SelfDemotionDialog({ memberRoles }: { memberRoles: OrgMemberRoles }) {
    const { t } = useTranslation();
    const { pendingSelfDemotion, setPendingSelfDemotion, handleUserRoleChange } = memberRoles;
    return (
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
    );
}

/**
 * Only an org admin may reshape what a role grants — the server refuses the
 * PUT for anyone else, so offering the toggles would be a lie.
 */
function canUserEditRoles(user: OrgUsersPanelUser | null | undefined): boolean {
    return !!(user?.isAdmin || ['org_admin', 'admin'].includes(user?.orgRole ?? ''));
}

const OrgUsersPanel = ({ user, initialSection: _initialSection, basePath = LEGACY_BASE_PATH }: OrgUsersPanelProps) => {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [activeSection, setActiveSection] = useUrlTab({
        basePath,
        validValues: ORG_USERS_SECTIONS,
        defaultValue: 'users',
        aliases: ORG_USERS_URL_ALIASES,
    });
    const directory = useOrgDirectory({ user });
    const { users, groups, orgRolePerms, setOrgRolePerms, editablePermissions, organizations, loading, customTiersMeta, fetchData } = directory;
    const groupsState = useOrgGroups({ users, organizations, fetchData, confirm });
    const invites = useOrgInvitations();
    const memberRoles = useOrgMemberRoles({ fetchData, confirm });
    const { roleChangeError, setRoleChangeError } = memberRoles;

    // Expanded role details
    const [expandedRole, setExpandedRole] = useState<string | null>(null);

    const userOrgIds = getUserOrgIds(user, groups);
    const orgGroups = groups.filter(g => g.organizationId && userOrgIds.has(g.organizationId));
    // The tab badge counts the roles the tab LISTS. It used to filter the
    // system-role table down to three hardcoded ids and count those, so the
    // header read "Roles 3" above a list of six — the DPO, the ISMS auditor and
    // the Member were listed but never counted.
    const orgRoleCount = ORG_ROLES.length;

    const canEditRoles = canUserEditRoles(user);

    const handleRolePermissionsSaved = (roleId: string, permissions: string[]) => {
        setOrgRolePerms(prev => spliceRolePermissions(prev, roleId, permissions, editablePermissions));
    };

    // Trust the server's org scoping. GET /auth/users already returns exactly
    // the org members the caller may see (scoped server-side via
    // resolveUserOrgIds, self always included). Re-deriving the org set on the
    // client from `user.organizationId` caused the member list to diverge
    // between the embedded Nextcloud view and standalone, and could hide
    // members from an org-admin whose client-side org pointer was stale. We
    // only drop system rows here.
    const orgUsers = users.filter(u => !u.isSystem);

    // Filter state lives here (not in the Users tab) so it survives a tab switch.
    const userFilters = useUserFilters(orgUsers, { groups });

    if (loading) return <PanelSkeleton />;

    const isNcOrg = !!user?.ncOrg?.instanceId;
    const sections = [
        { id: 'users', label: t('admin.users_tab_users', 'Users'), icon: <Users className="w-4 h-4" />, badge: orgUsers.length },
        { id: 'groups', label: t('admin.users_tab_groups', 'Groups'), icon: <UserPlus className="w-4 h-4" />, badge: orgGroups.length },
        { id: 'roles', label: t('admin.users_tab_roles', 'Roles'), icon: <Shield className="w-4 h-4" />, badge: orgRoleCount },
    ];
    const goToGroups = (createGroup = false) => {
        setActiveSection('groups');
        if (createGroup) groupsState.setShowCreateGroup(true);
    };

    return (
        <div className="max-w-4xl space-y-6">
            {/* Section tabs. The shared tab bar, as on Organisation →
                Integrations: tab semantics and arrow keys. 'customTiers' and
                'sync' have no tab, so no tab is selected while they show. */}
            <Tabs
                value={activeSection}
                onChange={setActiveSection}
                ariaLabel={t('settings.users_groups', 'Users & Groups')}
                items={sections}
            />

            {activeSection === 'users' && (
                <UsersSection
                    directory={directory}
                    orgUsers={orgUsers}
                    orgGroups={orgGroups}
                    groupsState={groupsState}
                    invites={invites}
                    memberRoles={memberRoles}
                    userFilters={userFilters}
                    onGoToGroups={goToGroups}
                />
            )}

            {activeSection === 'groups' && (
                <GroupsSection
                    orgGroups={orgGroups}
                    orgUsers={orgUsers}
                    organizations={organizations}
                    customTiersMeta={customTiersMeta}
                    groupsState={groupsState}
                />
            )}

            {activeSection === 'roles' && (
                <RolesSection
                    users={users}
                    orgRolePerms={orgRolePerms}
                    editablePermissions={editablePermissions}
                    canEditRoles={canEditRoles}
                    onRolePermissionsSaved={handleRolePermissionsSaved}
                    expandedRole={expandedRole}
                    setExpandedRole={setExpandedRole}
                />
            )}

            {activeSection === 'customTiers' && (
                <OrgCustomTiersPanel />
            )}

            {activeSection === 'sync' && isNcOrg && (
                <NextcloudSyncPanel user={user} />
            )}

            {roleChangeError && (
                <RoleChangeErrorBanner message={roleChangeError} onDismiss={() => setRoleChangeError('')} />
            )}

            {confirmDialog}
            <SelfDemotionDialog memberRoles={memberRoles} />
        </div>
    );
};

export default OrgUsersPanel;
