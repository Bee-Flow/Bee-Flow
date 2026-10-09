import { Building, Cloud, Key, Loader2, Shield, Tag, Users } from 'lucide-react';
import React, { useState } from 'react';
import PeopleDirectory from './people/PeopleDirectory';

import GroupModal from './userManagement/GroupModal';
import GroupsSection from './userManagement/GroupsSection';
import MyOrganizationSection from './userManagement/MyOrganizationSection';
import NextcloudBindingsSection from './userManagement/NextcloudBindingsSection';
import OrganizationModal from './userManagement/OrganizationModal';
import OrganizationsSection from './userManagement/OrganizationsSection';
import PermissionsSection from './userManagement/PermissionsSection';
import RoleModal from './userManagement/RoleModal';
import RolesSection from './userManagement/RolesSection';
import useGroupActions from './userManagement/useGroupActions';
import useOrgActions from './userManagement/useOrgActions';
import UserModal from './userManagement/UserModal';
import useRoleActions from './userManagement/useRoleActions';
import useUserActions from './userManagement/useUserActions';
import useUserManagementData from './userManagement/useUserManagementData';
import { useTranslation } from '../../../hooks/useTranslation';
import ConfirmDialog from '../../shared/ConfirmDialog';

const UserManagement = ({ activeSection: activeSectionProp = '', onNavigate, user: currentUser }) => {
    const { t } = useTranslation();
    const VALID_SECTIONS = ['users', 'organizations', 'groups', 'roles', 'permissions', 'my-organization'];
    const activeSection = VALID_SECTIONS.includes(activeSectionProp) ? activeSectionProp : 'users';

    // Permission check: full admin can do everything, org-scoped users are limited
    const isFullAdmin = currentUser?.permissions?.includes('all') || currentUser?.isAdmin;
    const canManageUsers = isFullAdmin || (currentUser?.permissions || []).some(p => ['manage_users', 'admin_security'].includes(p));
    // Platform operator — deliberately NOT isFullAdmin, which counts the 'all'
    // permission and is obtainable inside a tenant. Moving a user between
    // organisations is server-side restricted to this exact test
    // (session.isAdmin || user.role === 'admin'), so the org picker below has to
    // ask the same question or it offers an action that answers 403.
    const isPlatformAdmin = currentUser?.isAdmin || currentUser?.role === 'admin';
    const userOrgIds = currentUser?.organizations || [];

    const { users, groups, organizations, roles, permissions, loading, message, setMessage, loadData } = useUserManagementData();

    // Destructive actions route through <ConfirmDialog/> rather than
    // window.confirm: the native dialog is unstyled, unthemeable, blocks the
    // event loop, and cannot be driven by a test.
    const [confirmState, setConfirmState] = useState(null);
    const askConfirm = (opts) => setConfirmState(opts);

    // The caller's own organisation — used by the my-organization section and by
    // the org-actions hook, which seeds its form from it.
    const myOrg = organizations.find(o => userOrgIds.includes(o.id));

    const userActions = useUserActions({ loadData, setMessage, askConfirm, t });
    const groupActions = useGroupActions({ loadData, setMessage, askConfirm, t });
    const roleActions = useRoleActions({ loadData, setMessage, askConfirm, t });
    const orgActions = useOrgActions({ loadData, setMessage, askConfirm, t, activeSection, myOrg });

    const sections = isFullAdmin ? [
        { key: 'users', labelKey: 'admin.users_tab_users', icon: Users },
        { key: 'organizations', labelKey: 'admin.users_tab_organizations', icon: () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" /><path d="M10 6h4" /><path d="M10 10h4" /><path d="M10 14h4" /><path d="M10 18h4" /></svg> },
        { key: 'nextcloud', labelKey: 'admin.users_tab_nextcloud', icon: Cloud },
        { key: 'groups', labelKey: 'admin.users_tab_groups', icon: Shield },
        { key: 'roles', labelKey: 'admin.users_tab_roles', icon: Tag },
        { key: 'permissions', labelKey: 'admin.users_tab_permissions', icon: Key },
    ] : [
        { key: 'users', labelKey: 'admin.users_tab_users', icon: Users },
        { key: 'groups', labelKey: 'admin.users_tab_groups', icon: Shield },
        ...(userOrgIds.length > 0 ? [{ key: 'my-organization', labelKey: 'admin.users_tab_my_org', icon: Building }] : []),
    ];

    return (
        <div className="h-full flex flex-col">
            {/* Section Tabs */}
            <div className="px-6 py-4 border-b flex items-center gap-4 border-[var(--border-subtle)]">
                {sections.map(({ key, labelKey, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => { if (onNavigate) onNavigate(`admin/security/users/${key}`); }}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${activeSection === key
                            ? 'bg-[var(--accent-primary)] text-white'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                            }`}
                    >
                        <Icon className="w-4 h-4" />
                        {t(labelKey)}
                    </button>
                ))}
                <div className="flex-1" />
                {message && (
                    <span className={`text-sm ${message.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                        {typeof message.text === 'string' ? message.text : JSON.stringify(message.text)}
                    </span>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6">
                {loading ? (
                    <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
                        <Loader2 className="w-6 h-6 animate-spin mr-2" /> {t('admin_org.user_mgmt_loading', 'Loading data...')}
                    </div>
                ) : (
                    <>
                        {/* Users Section */}
                        {activeSection === 'users' && (
                            <PeopleDirectory
                                users={users}
                                groups={groups}
                                organizations={organizations}
                                canManageUsers={canManageUsers}
                                onAddUser={userActions.openAddUser}
                                onEditUser={userActions.openEditUser}
                                onResetMfa={userActions.handleResetMfa}
                                onDeleteUser={(user) => userActions.handleDeleteUser(user.id)}
                            />
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
                                canManageUsers={canManageUsers}
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

export default UserManagement;
