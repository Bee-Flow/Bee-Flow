import { Check, Clock, Edit2, Mail, X } from 'lucide-react';
import GroupAssignPopover from './GroupAssignPopover';
import BudgetEditor from './BudgetEditor';
import { ORG_ROLES } from '@/config/orgRoles';
import { useTranslation } from '@/hooks/useTranslation';
import { useDeploymentMode } from '@/hooks/useDeploymentMode';
import { API_BASE } from '@/utils/helpers';
import RoleBadge from '@/components/shared/RoleBadge';
import type { MemberUsage, OrgGroupRow, OrgMember } from '../useOrgDirectory';
import type { OrgGroups } from '../useOrgGroups';
import type { OrgMemberRoles } from '../useOrgMemberRoles';

interface OrgMemberRowProps {
    member: OrgMember;
    orgGroups: OrgGroupRow[];
    usage: MemberUsage | undefined;
    groupsState: OrgGroups;
    memberRoles: OrgMemberRoles;
    onCreateGroup: () => void;
    /**
     * The viewer may change this account (utils/adminAccess mayManageAccount).
     * Without it the row is read-only: the server refuses every write on it.
     */
    manageable: boolean;
}

function MemberAvatar({ member: u }: { member: OrgMember }) {
    if (u.avatarType === 'emoji' && u.avatar) {
        return (
            <div className="w-9 h-9 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center text-lg shrink-0">
                {u.avatar}
            </div>
        );
    }
    if (((u.avatarType === 'image' || u.avatarType === 'url') && u.avatar)
        || (u.avatar && (u.avatar.startsWith('http') || u.avatar.startsWith('/')))) {
        return <img src={u.avatar.startsWith('/') ? `${API_BASE}${u.avatar}` : u.avatar} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />;
    }
    return (
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
            {(u.displayName || u.username || '?')[0].toUpperCase()}
        </div>
    );
}

/**
 * AI cost of the member; nothing when they spent nothing. Self-hosted shows the
 * calendar month (the period the monthly AI budget is enforced on), cloud the
 * last 30 days; useOrgDirectory fetches the matching window.
 */
function MemberUsageCost({ usage }: { usage: MemberUsage | undefined }) {
    const { t } = useTranslation();
    const { isSelfHosted } = useDeploymentMode();
    if (!usage || !usage.cost) return null;
    const cost = usage.cost;
    const display = cost >= 100 ? `€${cost.toFixed(0)}` : cost >= 1 ? `€${cost.toFixed(2)}` : `€${cost.toFixed(3)}`;
    const params = { calls: usage.calls.toLocaleString(), cost: `€${cost.toFixed(4)}` };
    return (
        <div
            className="hidden md:flex flex-col items-end shrink-0 text-right"
            title={isSelfHosted
                ? t('admin.org_usage_tooltip_month', '{calls} requests · {cost} this calendar month, the period of the AI budget', params)
                : t('admin.org_usage_tooltip', params)}
        >
            <span className="text-[11px] font-semibold text-[var(--text-primary)] leading-tight">{display}</span>
            <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wider leading-tight">
                {isSelfHosted ? t('admin.org_usage_cost_month', 'cost · this month') : t('admin.org_usage_cost_30d')}
            </span>
        </div>
    );
}

function PendingActions({ userId, memberRoles }: { userId: string; memberRoles: OrgMemberRoles }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1">
            <button
                onClick={() => memberRoles.handleApproveUser(userId)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
                title={t('admin_org.users_approve_title', 'Approve user')}
            >
                <Check className="w-3.5 h-3.5" />
                {t('admin.org_approve', 'Approve')}
            </button>
            <button
                onClick={() => memberRoles.handleRejectUser(userId)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                title={t('admin_org.users_reject_title', 'Reject user')}
            >
                <X className="w-3.5 h-3.5" />
                {t('admin.org_reject', 'Reject')}
            </button>
        </div>
    );
}

function RoleDropdown({ member: u, memberRoles }: { member: OrgMember; memberRoles: OrgMemberRoles }) {
    const { t } = useTranslation();
    const { editingUserRole, setEditingUserRole, handleUserRoleChange } = memberRoles;
    return (
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
    );
}

/** One member of the Users tab: who, which groups, what they spent, and what can be done. */
export default function OrgMemberRow({ member: u, orgGroups, usage, groupsState, memberRoles, onCreateGroup, manageable }: OrgMemberRowProps) {
    const { t } = useTranslation();
    const uGroups = Array.isArray(u.groups) ? u.groups : [];
    const userOrgGroups = orgGroups.filter(g => uGroups.includes(g.id));
    return (
        <div className="px-5 py-3 flex items-center gap-4 hover:bg-[var(--bg-secondary)] transition-colors">
            <MemberAvatar member={u} />
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
                        <RoleBadge role={u.orgRole || u.role} />
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
            <MemberUsageCost usage={usage} />
            {manageable && (
                <MemberActions member={u} orgGroups={orgGroups} groupsState={groupsState} memberRoles={memberRoles} onCreateGroup={onCreateGroup} />
            )}
        </div>
    );
}

/** What can be done to a member: approve or reject a pending one, else budget, role and groups. */
function MemberActions({ member: u, orgGroups, groupsState, memberRoles, onCreateGroup }: Omit<OrgMemberRowProps, 'usage' | 'manageable'>) {
    const { t } = useTranslation();
    const { isSelfHosted } = useDeploymentMode();
    if (u.status === 'pending') return <PendingActions userId={u.id} memberRoles={memberRoles} />;
    return (
        <>
            {isSelfHosted && (
                <BudgetEditor
                    value={u.monthlyCostLimit}
                    label={t('admin_org.user_modal_cost_limit', 'Monthly AI budget (€)')}
                    suffix="/mo"
                    onSave={v => memberRoles.handleUpdateUserCostLimit(u.id, v)}
                />
            )}
            <RoleDropdown member={u} memberRoles={memberRoles} />
            <GroupAssignPopover
                userId={u.id}
                userGroups={Array.isArray(u.groups) ? u.groups : []}
                orgGroups={orgGroups}
                groupsState={groupsState}
                onCreateGroup={onCreateGroup}
            />
        </>
    );
}
