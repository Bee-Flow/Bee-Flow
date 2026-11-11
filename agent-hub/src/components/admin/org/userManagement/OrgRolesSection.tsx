import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAdminOrgScope } from '@/api/adminOrgScope';
import { orgRolesKey, useOrgRoles, type OrgRoleMapping } from '@/api/queries/orgAdminReads';
import Spinner from '@/components/shared/Spinner';
import { useTranslation } from '@/hooks/useTranslation';
import { canUserEditRoles, spliceRolePermissions } from '../orgUsers/roleEditing';
import RolesSection from '../orgUsers/RolesSection';
import type { OrgMember } from '../useOrgDirectory';
import { isHomeOrgAdmin, isPlatformAdmin } from '@/utils/adminAccess';
import type { AdminCurrentUser, AdminUser } from './types';

interface OrgRolesSectionProps {
    users: AdminUser[];
    currentUser: AdminCurrentUser | null | undefined;
}

/** The organisation's own roles, what each grants, and (for an organisation admin) the switches. */
export default function OrgRolesSection({ users, currentUser }: OrgRolesSectionProps) {
    const { t } = useTranslation();
    const orgId = useAdminOrgScope();
    const queryClient = useQueryClient();
    const { mapping, editablePermissions, loading } = useOrgRoles(orgId);
    const [expandedRole, setExpandedRole] = useState<string | null>(null);
    if (loading) {
        return (
            <div className="flex items-center justify-center gap-2 text-sm text-[var(--text-tertiary)]">
                <Spinner size="sm" /> {t('admin_org.user_mgmt_loading', 'Loading data...')}
            </div>
        );
    }
    const canEdit = isPlatformAdmin(currentUser) || isHomeOrgAdmin(currentUser) || canUserEditRoles(currentUser as { isAdmin?: boolean; orgRole?: string | null });
    // What each role grants, and which of it the organisation may switch: a save splices the one role into the cached answer.
    const onSaved = (roleId: string, permissions: string[]) => queryClient.setQueryData<OrgRoleMapping>(orgRolesKey(orgId), prev => prev && {
        ...prev, roles: spliceRolePermissions(prev.roles, roleId, permissions, prev.editablePermissions),
    });
    return (
        <RolesSection
            users={users as OrgMember[]}
            orgRolePerms={mapping}
            editablePermissions={editablePermissions}
            canEditRoles={canEdit}
            onRolePermissionsSaved={onSaved}
            expandedRole={expandedRole}
            setExpandedRole={setExpandedRole}
        />
    );
}
