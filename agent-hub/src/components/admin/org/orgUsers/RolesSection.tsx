import { ChevronDown, ChevronRight, Shield, Users } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { ORG_ROLES, permissionsForRole } from '@/config/orgRoles';
import { useTranslation } from '@/hooks/useTranslation';
import RolePermissionEditor from '../RolePermissionEditor';
import { CHIP } from '@/components/shared/adminUi';
import { nOf } from '@/utils/plural';
import type { OrgMember, OrgRolePermissions } from '../useOrgDirectory';

type OrgRole = (typeof ORG_ROLES)[number];

interface RolesSectionProps {
    users: OrgMember[];
    orgRolePerms: OrgRolePermissions[];
    editablePermissions: string[];
    /** Only an org admin may reshape what a role grants. */
    canEditRoles: boolean;
    onRolePermissionsSaved: (roleId: string, permissions: string[]) => void;
    /** Owned by the panel, so the open role survives a switch to another tab. */
    expandedRole: string | null;
    setExpandedRole: Dispatch<SetStateAction<string | null>>;
}

interface RoleRowProps extends Omit<RolesSectionProps, 'users' | 'expandedRole' | 'setExpandedRole'> {
    role: OrgRole;
    assignedCount: number;
    isExpanded: boolean;
    onToggle: () => void;
}

function RoleRow({ role, assignedCount, isExpanded, onToggle, orgRolePerms, editablePermissions, canEditRoles, onRolePermissionsSaved }: RoleRowProps) {
    const { t } = useTranslation();
    const rolePermissions: Array<{ id: string; label: string }> = permissionsForRole(role.id, orgRolePerms);
    return (
        <div className="group">
            <button
                onClick={onToggle}
                className="w-full px-5 py-4 flex items-start gap-4 text-left hover:bg-[var(--item-hover-bg)] transition-colors"
            >
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-[var(--bg-tertiary)]">
                    <Shield className="w-5 h-5 text-[var(--text-primary)]" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{role.name}</span>
                        <span className={CHIP}>{role.id}</span>
                        {assignedCount > 0 && (
                            <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                                <Users className="w-2.5 h-2.5" />
                                {nOf(t, 'admin_people.role_assigned', assignedCount, '{count} person', '{count} people')}
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">{role.description}</p>

                    {/* Permission badges - always visible, as neutral theme
                        chips (the same for every role). */}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                        {rolePermissions.map(p => (
                            <span key={p.id} className={CHIP}>
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
                    onSaved={onRolePermissionsSaved}
                />
            )}
        </div>
    );
}

/** The Roles tab: every org role, what it grants, and (for an org admin) the switches. */
export default function RolesSection({ users, expandedRole, setExpandedRole, ...rest }: RolesSectionProps) {
    const { t } = useTranslation();
    // Count users with a specific role
    const getUsersWithRole = (roleId: string) => users.filter(u => u.orgRole === roleId && !u.isSystem).length;
    return (
        <div className="space-y-3">
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('admin.org_roles_title', 'Organisation Roles')}</h3>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        {t('admin.org_roles_desc', 'These roles define what members can do within your organisation. Assign roles in the Users tab.')}
                    </p>
                </div>
                <div className="divide-y divide-[var(--border-subtle)]">
                    {ORG_ROLES.map(role => {
                        const isExpanded = expandedRole === role.id;
                        return (
                            <RoleRow
                                key={role.id}
                                role={role}
                                assignedCount={getUsersWithRole(role.id)}
                                isExpanded={isExpanded}
                                onToggle={() => setExpandedRole(isExpanded ? null : role.id)}
                                {...rest}
                            />
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
