import { Mail, Plus, X } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import RoleBadge from '@/components/shared/RoleBadge';
import type { OrgGroupRow, OrgMember } from '../useOrgDirectory';
import type { OrgGroups } from '../useOrgGroups';

interface GroupMembersProps {
    group: OrgGroupRow;
    orgUsers: OrgMember[];
    groupsState: OrgGroups;
}

/** Members of the org not yet in the group (same org as the group), narrowed by the search. */
function addCandidates(orgUsers: OrgMember[], group: OrgGroupRow) {
    return orgUsers
        .filter(u => !(Array.isArray(u.groups) ? u.groups : []).includes(group.id))
        .filter(u => group.organizationId ? u.organizationId === group.organizationId : true);
}

function matchesSearch(u: OrgMember, q: string) {
    return !q
        || (u.displayName || '').toLowerCase().includes(q)
        || (u.username || '').toLowerCase().includes(q)
        || (u.email || '').toLowerCase().includes(q);
}

/** Add member directly from the group view (BFSF-219). */
export function GroupMemberAdd({ group, orgUsers, groupsState }: GroupMembersProps) {
    const { t } = useTranslation();
    const { memberAddGroupId, setMemberAddGroupId, memberAddSearch, setMemberAddSearch, memberBusy, addGroupMember } = groupsState;

    const renderCandidates = () => {
        const candidates = addCandidates(orgUsers, group);
        const q = memberAddSearch.trim().toLowerCase();
        const shown = candidates.filter(u => matchesSearch(u, q)).slice(0, 20);
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
    };

    return (
        <div className="mb-3">
            {memberAddGroupId === group.id ? (
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-2">
                    <input
                        autoFocus
                        value={memberAddSearch}
                        onChange={e => setMemberAddSearch(e.target.value)}
                        placeholder={t('admin.org_group_add_member_search', 'Search users to add…')}
                        className="w-full px-2.5 py-1.5 rounded-md border text-xs outline-none mb-1.5 [background:var(--bg-secondary)] [border-color:var(--border-subtle)] [color:var(--text-primary)]!"
                    />
                    <div className="max-h-40 overflow-y-auto space-y-1">
                        {renderCandidates()}
                    </div>
                    <button onClick={() => { setMemberAddGroupId(null); setMemberAddSearch(''); }} className="mt-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                        {t('common.close', 'Close')}
                    </button>
                </div>
            ) : (
                <button onClick={() => { setMemberAddGroupId(group.id); setMemberAddSearch(''); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed hover:bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-secondary)]">
                    <Plus className="w-3.5 h-3.5" /> {t('admin.org_group_add_member', 'Add member')}
                </button>
            )}
        </div>
    );
}

/** The group's current members, each removable. */
export function GroupMembersList({ group, groupsState }: Omit<GroupMembersProps, 'orgUsers'>) {
    const { t } = useTranslation();
    const { getGroupMembers, memberBusy, removeGroupMember } = groupsState;
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
                        <RoleBadge role={group.orgRole || m.role || m.orgRole} />
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
}
