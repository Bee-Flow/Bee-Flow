import { useEffect, useState } from 'react';
import { settled } from '@/api/settled';
import { API_BASE } from '@/utils/helpers';
import { useAdminOrgScope, withOrgIdParam } from '@/api/adminOrgScope';
import Spinner from '@/components/shared/Spinner';
import { useTranslation } from '@/hooks/useTranslation';
import { canUserEditRoles, spliceRolePermissions } from '../orgUsers/roleEditing';
import RolesSection from '../orgUsers/RolesSection';
import type { OrgMember, OrgRolePermissions } from '../useOrgDirectory';
import { isHomeOrgAdmin, isPlatformAdmin } from '@/utils/adminAccess';
import type { AdminCurrentUser, AdminUser } from './types';

interface OrgRolesSectionProps {
    users: AdminUser[];
    currentUser: AdminCurrentUser | null | undefined;
}

/** What each organisation role grants (GET /auth/org-roles), and which of it the organisation may switch. */
function useOrgRoleMapping() {
    const orgId = useAdminOrgScope();
    const [mapping, setMapping] = useState<OrgRolePermissions[]>([]);
    const [editablePermissions, setEditablePermissions] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const res = await settled(withOrgIdParam(`${API_BASE}/auth/org-roles`, orgId), undefined, 'empty');
            if (res.ok) {
                const body: { roles?: OrgRolePermissions[]; editablePermissions?: string[] } | null = await res.res.json();
                if (!cancelled) { setMapping(body?.roles || []); setEditablePermissions(body?.editablePermissions || []); }
            }
            if (!cancelled) setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [orgId]);
    return { mapping, setMapping, editablePermissions, loading };
}

/** The organisation's own roles, what each grants, and (for an organisation admin) the switches. */
export default function OrgRolesSection({ users, currentUser }: OrgRolesSectionProps) {
    const { t } = useTranslation();
    const { mapping, setMapping, editablePermissions, loading } = useOrgRoleMapping();
    const [expandedRole, setExpandedRole] = useState<string | null>(null);
    if (loading) {
        return (
            <div className="flex items-center justify-center gap-2 text-sm text-[var(--text-tertiary)]">
                <Spinner size="sm" /> {t('admin_org.user_mgmt_loading', 'Loading data...')}
            </div>
        );
    }
    const canEdit = isPlatformAdmin(currentUser) || isHomeOrgAdmin(currentUser) || canUserEditRoles(currentUser as { isAdmin?: boolean; orgRole?: string | null });
    const onSaved = (roleId: string, permissions: string[]) => setMapping(prev => spliceRolePermissions(prev, roleId, permissions, editablePermissions));
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
