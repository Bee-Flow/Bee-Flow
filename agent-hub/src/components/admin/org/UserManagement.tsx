import { Building, Cloud, Key, Layers, RefreshCw, Send, Shield, Tag, Users, UserCog } from 'lucide-react';
import React, { useState, type ComponentType } from 'react';
import PeopleDirectory from './people/PeopleDirectory';

import GroupModal from './userManagement/GroupModal';
import GroupsSection from './userManagement/GroupsSection';
import MyOrganizationSection from './userManagement/MyOrganizationSection';
import NextcloudBindingsSection from './userManagement/NextcloudBindingsSection';
import OrganizationModal from './userManagement/OrganizationModal';
import OrganizationsSection from './userManagement/OrganizationsSection';
import OrgTabContent, { ORG_ONLY_SECTIONS, useOrgTabTarget } from './userManagement/OrgTabContent';
import PermissionsSection from './userManagement/PermissionsSection';
import RoleModal from './userManagement/RoleModal';
import RolesSection from './userManagement/RolesSection';
import useGroupActions from './userManagement/useGroupActions';
import useOrgActions from './userManagement/useOrgActions';
import UserModal from './userManagement/UserModal';
import UsersOrgControls from './userManagement/UsersOrgControls';
import useCustomTiersMeta from './useCustomTiersMeta';
import type { CustomTierMeta } from './useOrgDirectory';
import useRoleActions from './userManagement/useRoleActions';
import useUserActions from './userManagement/useUserActions';
import useUserManagementData, { type UserManagementData } from './userManagement/useUserManagementData';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { useDeploymentMode } from '@/hooks/useDeploymentMode';
import ConfirmDialog from '../../shared/ConfirmDialog';
import Spinner from '@/components/shared/Spinner';
import Tabs from '@/components/shared/Tabs';
import { ALERT_ERROR, ALERT_INFO, ALERT_SUCCESS } from '@/components/mcpLibrary/ui';
import { homeOrgIdOf, isPlatformAdmin as isPlatformAdminUser } from '@/utils/adminAccess';
import { OrgIcon } from './userManagement/EntityRows';
import type { AdminCurrentUser, ConfirmOptions } from './userManagement/types';
import { adminSectionScope } from '@/components/admin/dashboard/adminTabs';
import { ServerWideMark, serverWideLast } from '@/components/admin/dashboard/serverWideNav';
import { useAdminOrgIdParam } from '@/components/admin/dashboard/useAdminOrg';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';

/** Is this tab of the screen about the whole server (adminTabs: security `users/<tab>`)? */
const isServerWideTab = (key: string) => adminSectionScope('security', 'users', key) === 'instance';

interface UserManagementProps {
    activeSection?: string;
    onNavigate?: (path: string) => void;
    user?: AdminCurrentUser | null;
}

/**
 * The section tabs this person may open: everything for a platform admin,
 * users/groups (and their own organisation) otherwise. The 'all' permission
 * is not enough: its holder's lists cover their own organisation only, and
 * the server-wide role table is not read for them.
 */
interface SectionDef {
    key: string;
    labelKey: string;
    /** English text for a label whose key is not in the generated dictionary yet. */
    fallback?: string;
    icon: ComponentType<{ className?: string }>;
}

function sectionsFor(isPlatformAdmin: boolean | undefined, hasOrg: boolean, mayManage: boolean, hasNcSync: boolean): SectionDef[] {
    // The organisation-only tabs, in the order Settings > Organisation > Users & Groups had them.
    const orgTabs = [
        ...(mayManage ? [{ key: 'invitations', labelKey: 'admin_org.users_tab_invitations', fallback: 'Invitations', icon: Send }] : []),
        { key: 'groups', labelKey: 'admin.users_tab_groups', icon: Shield },
        { key: 'org-roles', labelKey: 'admin_org.users_tab_org_roles', fallback: 'Organisation roles', icon: UserCog },
        ...(mayManage ? [{ key: 'custom-tiers', labelKey: 'admin_org.users_tab_custom_tiers', fallback: 'Model tiers', icon: Layers }] : []),
        ...(hasNcSync ? [{ key: 'sync', labelKey: 'admin_org.users_tab_nc_sync', fallback: 'Nextcloud sync', icon: RefreshCw }] : []),
    ];
    return isPlatformAdmin ? [
        { key: 'users', labelKey: 'admin.users_tab_users', icon: Users },
        { key: 'organizations', labelKey: 'admin.users_tab_organizations', icon: OrgIcon },
        { key: 'nextcloud', labelKey: 'admin.users_tab_nextcloud', icon: Cloud },
        ...orgTabs,
        { key: 'roles', labelKey: 'admin_org.users_tab_server_roles', fallback: 'Server roles', icon: Tag },
        { key: 'permissions', labelKey: 'admin.users_tab_permissions', icon: Key },
    ] : [
        { key: 'users', labelKey: 'admin.users_tab_users', icon: Users },
        ...orgTabs,
        ...(hasOrg ? [{ key: 'my-organization', labelKey: 'admin.users_tab_my_org', icon: Building }] : []),
    ];
}

const UserManagement = ({ activeSection: activeSectionProp = '', onNavigate, user: currentUser }: UserManagementProps) => {
    const { t } = useTranslation();
    const VALID_SECTIONS = ['users', 'organizations', 'nextcloud', 'groups', 'roles', 'permissions', 'my-organization', ...ORG_ONLY_SECTIONS];
    const activeSection = VALID_SECTIONS.includes(activeSectionProp) ? activeSectionProp : 'users';

    // Permission check: full admin can do everything, org-scoped users are limited
    const isFullAdmin = currentUser?.permissions?.includes('all') || currentUser?.isAdmin;
    const canManageUsers = isFullAdmin || (currentUser?.permissions || []).some(p => ['manage_users', 'admin_security'].includes(p));
    // Platform operator — deliberately NOT isFullAdmin, which counts the 'all'
    // permission and is obtainable inside a tenant. Moving a user between
    // organisations is server-side restricted to this exact test
    // (utils/adminAccess, the server's isSuperAdmin), so the org picker below has to
    // ask the same question or it offers an action that answers 403.
    const isPlatformAdmin = isPlatformAdminUser(currentUser);
    const userOrgIds = currentUser?.organizations || [];

    // The admin dashboard's lists (`?scope=admin`): an organisation admin's home organisation only,
    // a platform admin's the organisation chosen in the dashboard (none chosen: every organisation).
    const orgId = useAdminOrgIdParam();
    const { users, groups, organizations, roles, permissions, loading, notOrgAdmin, message, setMessage, loadData } = useUserManagementData({ currentUser, orgId });
    // The dashboard's scope bar follows the open tab: the organisations, Nextcloud, roles and permissions are server-wide.
    useAdminScopeOverride(isPlatformAdmin ? adminSectionScope('security', 'users', activeSection) : 'org');
    // The controls follow the lists: when the server refused them, it refuses the edits too.
    const mayManageListed = !!canManageUsers && !notOrgAdmin;
    // The organisation-only tabs follow the dashboard's organisation; the requests name it for a platform admin only.
    const orgTarget = useOrgTabTarget(currentUser);
    
    // Destructive actions route through <ConfirmDialog/> rather than
    // window.confirm: the native dialog is unstyled, unthemeable, blocks the
    // event loop, and cannot be driven by a test.
    const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null);
    const askConfirm = (opts: ConfirmOptions) => setConfirmState(opts);

    // The caller's own organisation — used by the my-organization section and by
    // the org-actions hook, which seeds its form from it. The home org first
    // (useOrgDirectory does the same): `organizations` comes in id order, and an
    // org the caller only belongs to through a group is not one they administer.
    const homeOrgId = typeof currentUser?.organizationId === 'string' ? currentUser.organizationId : '';
    const myOrg = (homeOrgId ? organizations.find(o => o.id === homeOrgId) : undefined)
        ?? organizations.find(o => userOrgIds.includes(o.id));

    const { isSelfHosted } = useDeploymentMode();
    const userActions = useUserActions({ loadData, setMessage, askConfirm, t, isSelfHosted });
    const groupActions = useGroupActions({ loadData, setMessage, askConfirm, t, isSelfHosted });
    const roleActions = useRoleActions({ loadData, setMessage, askConfirm, t });
    // The pills are read once a group is being edited.
    const customTiersMeta = useCustomTiersMeta(groupActions.showEditGroup);
    const orgActions = useOrgActions({ loadData, setMessage, askConfirm, t, activeSection, myOrg });

    // The server-wide tabs go last, behind a "Whole server" divider, each with the server icon.
    const sections = serverWideLast(sectionsFor(isPlatformAdmin, userOrgIds.length > 0, mayManageListed, !!(currentUser?.ncOrg as { instanceId?: string | null } | null | undefined)?.instanceId), s => isPlatformAdmin && isServerWideTab(s.key));

    return (
        <div className="h-full flex flex-col">
            {/* Section tabs: the section is the URL (admin/security/users/<key>). */}
            <div className="flex flex-col gap-3 px-6 pt-4 md:px-8 md:pt-6">
                <Tabs
                    ariaLabel={t('admin.sec_users')}
                    value={activeSection}
                    onChange={(key) => { if (onNavigate) onNavigate(`admin/security/users/${key}`); }}
                    items={sections.map(({ key, labelKey, fallback, icon: Icon, serverWide, startsServerGroup }) => ({
                        id: key,
                        label: t(labelKey, fallback),
                        icon: <Icon className="h-4 w-4" aria-hidden="true" />,
                        mark: serverWide ? <ServerWideMark /> : undefined,
                        dividerBefore: startsServerGroup ? t('admin.scope_instance', 'Whole server') : undefined,
                    }))}
                />
                {notOrgAdmin && (
                    <div role="status" className={ALERT_INFO}>
                        {t('admin_org.user_mgmt_org_admins_only', 'This page is for administrators of the organisation, so ask a platform administrator if you need access.')}
                    </div>
                )}
                {message && (
                    <div role="status" className={message.type === 'success' ? ALERT_SUCCESS : ALERT_ERROR}>
                        {typeof message.text === 'string' ? message.text : JSON.stringify(message.text)}
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6 md:px-8">
                {loading ? (
                    <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-tertiary)]">
                        <Spinner size="sm" /> {t('admin_org.user_mgmt_loading', 'Loading data...')}
                    </div>
                ) : (
                    <>
                        {/* Users Section */}
                        {activeSection === 'users' && (
                            <>
                            <UsersOrgControls
                                key={orgId ?? homeOrgId}
                                org={organizations.find(o => o.id === (orgId ?? homeOrgId))}
                                needsChoice={orgTarget.needsChoice}
                                homeOrg={!orgTarget.scopeOrgId || orgTarget.scopeOrgId === homeOrgIdOf(currentUser)}
                                onChanged={loadData}
                            />
                            <PeopleDirectory
                                users={users}
                                groups={groups}
                                organizations={organizations}
                                canManageUsers={mayManageListed}
                                viewerIsPlatformAdmin={isPlatformAdmin}
                                viewerHomeOrgId={homeOrgIdOf(currentUser)}
                                scopeOrgId={orgId}
                                onAddUser={userActions.openAddUser}
                                onEditUser={userActions.openEditUser}
                                onResetMfa={userActions.handleResetMfa}
                                onDeleteUser={(user) => userActions.handleDeleteUser(user.id)}
                                onApproveUser={userActions.handleApproveUser}
                                onRejectUser={userActions.handleRejectUser}
                            />
                            </>
                        )}

                        {/* Invitations, the organisation's roles, its model tiers and Nextcloud sync */}
                        {(ORG_ONLY_SECTIONS as readonly string[]).includes(activeSection) && (
                            <OrgTabContent section={activeSection} target={orgTarget} users={users} currentUser={currentUser} />
                        )}

                        {/* Organizations Section */}
                        {activeSection === 'organizations' && (
                            <OrganizationsSection
                                organizations={organizations}
                                isFullAdmin={isFullAdmin}
                                onAddOrg={orgActions.openAddOrg}
                                onEditOrg={orgActions.openEditOrg}
                                onDeleteOrg={orgActions.handleDeleteOrg}
                                onRemoveNcBinding={orgActions.handleRemoveNcBinding}
                                t={t}
                            />
                        )}

                        {/* Nextcloud Bindings Section (global admin) */}
                        {activeSection === 'nextcloud' && (
                            <NextcloudBindingsSection
                                organizations={organizations}
                                onNavigate={onNavigate}
                                onRemoveNcBinding={orgActions.handleRemoveNcBinding}
                                t={t}
                            />
                        )}

                        {/* Groups Section */}
                        {activeSection === 'groups' && (
                            <GroupsSection
                                groups={groups}
                                organizations={organizations}
                                users={users}
                                canManageUsers={mayManageListed}
                                onAddGroup={groupActions.openAddGroup}
                                onEditGroup={groupActions.openEditGroup}
                                onDeleteGroup={groupActions.handleDeleteGroup}
                            />
                        )}

                        {/* Roles Section */}
                        {activeSection === 'roles' && (
                            <RolesSection
                                roles={roles}
                                onAddRole={roleActions.openAddRole}
                                onEditRole={roleActions.openEditRole}
                                onDeleteRole={roleActions.handleDeleteRole}
                            />
                        )}

                        {/* Permissions Section */}
                        {activeSection === 'permissions' && (
                            <PermissionsSection permissions={permissions} />
                        )}

                        {/* My Organization Section (for org-scoped users) */}
                        {activeSection === 'my-organization' && (
                            <MyOrganizationSection
                                myOrg={myOrg}
                                orgData={orgActions.orgData}
                                setOrgData={orgActions.setOrgData}
                                onSave={orgActions.handleUpdateOrg}
                                onUploadLogo={orgActions.handleMyOrgLogoUpload}
                                onRemoveLogo={orgActions.handleMyOrgLogoRemove}
                            />
                        )}
                    </>
                )}
            </div>

            <UserManagementModals
                userActions={userActions} orgActions={orgActions} groupActions={groupActions} roleActions={roleActions}
                groups={groups} organizations={organizations} permissions={permissions} roles={roles} customTiersMeta={customTiersMeta}
                isFullAdmin={isFullAdmin} isPlatformAdmin={isPlatformAdmin} currentUser={currentUser} t={t}
            />

            <ConfirmDialog
                open={!!confirmState}
                title={confirmState?.title || ''}
                description={confirmState?.description}
                confirmLabel={confirmState?.confirmLabel}
                cancelLabel={t('admin.sec_cancel', 'Cancel')}
                destructive={confirmState?.destructive}
                onConfirm={async () => {
                    const action = confirmState?.onConfirm;
                    setConfirmState(null);
                    if (action) await action();
                }}
                onCancel={() => setConfirmState(null)}
            />
        </div>
    );
};

interface UserManagementModalsProps {
    userActions: ReturnType<typeof useUserActions>;
    orgActions: ReturnType<typeof useOrgActions>;
    groupActions: ReturnType<typeof useGroupActions>;
    roleActions: ReturnType<typeof useRoleActions>;
    groups: UserManagementData['groups'];
    organizations: UserManagementData['organizations'];
    permissions: UserManagementData['permissions'];
    roles: UserManagementData['roles'];
    customTiersMeta: CustomTierMeta[];
    isFullAdmin: boolean | undefined;
    isPlatformAdmin: boolean;
    currentUser: UserManagementProps['user'];
    t: TranslateFn;
}

/** The four add/edit dialogs (user, organisation, group, role), each opened by its own actions hook. */
function UserManagementModals({
    userActions, orgActions, groupActions, roleActions, groups, organizations, permissions, roles, customTiersMeta,
    isFullAdmin, isPlatformAdmin, currentUser, t,
}: UserManagementModalsProps) {
    const { isSelfHosted } = useDeploymentMode();
    return (
        <>
        <UserModal
            open={userActions.showAddUser || userActions.showEditUser}
            onClose={userActions.closeUserModal}
            showEditUser={userActions.showEditUser}
            userData={userActions.userData}
            setUserData={userActions.setUserData}
            showEmojiPicker={userActions.showEmojiPicker}
            setShowEmojiPicker={userActions.setShowEmojiPicker}
            groups={groups}
            organizations={organizations}
            isPlatformAdmin={isPlatformAdmin}
            isSelfHosted={isSelfHosted}
            currentUserId={currentUser?.id}
            storedRole={userActions.storedRole}
            platformRoleRefusal={userActions.platformRoleRefusal}
            onSubmitAdd={userActions.handleAddUser}
            onSubmitUpdate={userActions.handleUpdateUser}
            onUploadAvatar={userActions.handleAvatarUpload}
            onRemoveAvatar={userActions.handleAvatarRemove}
            t={t}
        />

        <OrganizationModal
            open={orgActions.showAddOrg || orgActions.showEditOrg}
            onClose={orgActions.closeOrgModal}
            showEditOrg={orgActions.showEditOrg}
            orgData={orgActions.orgData}
            setOrgData={orgActions.setOrgData}
            groups={groups}
            isFullAdmin={isFullAdmin}
            onSubmitAdd={orgActions.handleAddOrg}
            onSubmitUpdate={orgActions.handleUpdateOrg}
            onUploadLogo={orgActions.handleOrgLogoUpload}
            onRemoveLogo={orgActions.handleOrgLogoRemove}
            t={t}
        />

        <GroupModal
            open={groupActions.showAddGroup || groupActions.showEditGroup}
            onClose={groupActions.closeGroupModal}
            showEditGroup={groupActions.showEditGroup}
            groupData={groupActions.groupData}
            setGroupData={groupActions.setGroupData}
            organizations={organizations}
            permissions={permissions}
            roles={roles}
            isFullAdmin={isFullAdmin}
            currentUser={currentUser}
            isSelfHosted={isSelfHosted}
            customTiersMeta={customTiersMeta}
            onSubmitAdd={groupActions.handleAddGroup}
            onSubmitUpdate={groupActions.handleUpdateGroup}
            t={t}
        />

        <RoleModal
            open={roleActions.showAddRole || roleActions.showEditRole}
            onClose={roleActions.closeRoleModal}
            showEditRole={roleActions.showEditRole}
            roleData={roleActions.roleData}
            setRoleData={roleActions.setRoleData}
            permissions={permissions}
            onSubmitAdd={roleActions.handleAddRole}
            onSubmitUpdate={roleActions.handleUpdateRole}
            t={t}
        />
        </>
    );
}

export default UserManagement;
