import { Check, Plus, Search, UserPlus } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { OrgGroupRow } from '../useOrgDirectory';
import type { OrgGroups } from '../useOrgGroups';

interface GroupAssignPopoverProps {
    userId: string;
    /** The member's current group ids. */
    userGroups: string[];
    orgGroups: OrgGroupRow[];
    groupsState: OrgGroups;
    /** Close the popover and open the Groups tab's create form. */
    onCreateGroup: () => void;
}

/** Selected first, then alphabetical within each segment. */
function sortGroupsForMember(orgGroups: OrgGroupRow[], userGroups: string[], search: string): OrgGroupRow[] {
    const q = search.trim().toLowerCase();
    const matches = q ? orgGroups.filter(g => (g.name || '').toLowerCase().includes(q)) : orgGroups;
    return [...matches].sort((a, b) => {
        const aSel = userGroups.includes(a.id) ? 0 : 1;
        const bSel = userGroups.includes(b.id) ? 0 : 1;
        if (aSel !== bSel) return aSel - bSel;
        return (a.name || '').localeCompare(b.name || '');
    });
}

/** One toggle per matching group, the member's own groups first. */
function GroupOptions({ userId, userGroups, orgGroups, groupsState }: Omit<GroupAssignPopoverProps, 'onCreateGroup'>) {
    const { t } = useTranslation();
    const { groupAssignSearch, getGroupCount, handleUserGroupToggle } = groupsState;
    const sorted = sortGroupsForMember(orgGroups, userGroups, groupAssignSearch);
    if (sorted.length === 0) {
        return <div className="px-3 py-3 text-[11px] text-[var(--text-muted)] text-center">{t('admin.org_assign_groups_no_match', 'No groups match your search.')}</div>;
    }
    return sorted.map(g => {
        const isMember = userGroups.includes(g.id);
        const memberCount = getGroupCount(g.id);
        return (
            <button
                key={g.id}
                type="button"
                onClick={() => handleUserGroupToggle(userId, g.id, userGroups)}
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
}

/** The open popover: search (for more than five groups), one toggle per group, and a way to create one. */
function GroupAssignMenu({ userId, userGroups, orgGroups, groupsState, onCreateGroup }: GroupAssignPopoverProps) {
    const { t } = useTranslation();
    const { groupAssignSearch, setGroupAssignSearch } = groupsState;
    return (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-xl z-50">
            <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between">
                <div className="text-xs font-semibold text-[var(--text-primary)]">{t('admin.org_assign_groups_title', 'Groups')}</div>
                <span className="text-[10px] text-[var(--text-muted)]">
                    {t('admin.org_assign_groups_selected', '{count} selected').replace('{count}', String(userGroups.length))}
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
                            onClick={onCreateGroup}
                            className="inline-flex items-center gap-1 text-[11px] text-[var(--accent-primary)] hover:underline"
                        >
                            <Plus className="w-3 h-3" />
                            {t('admin.org_new_group', 'Create New Group')}
                        </button>
                    </div>
                ) : <GroupOptions userId={userId} userGroups={userGroups} orgGroups={orgGroups} groupsState={groupsState} />}
            </div>
            {orgGroups.length > 0 && (
                <div className="px-2 py-1.5 border-t border-[var(--border-subtle)]">
                    <button
                        onClick={onCreateGroup}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-medium text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/5 transition-colors"
                    >
                        <Plus className="w-3 h-3" />
                        {t('admin.org_new_group', 'Create New Group')}
                    </button>
                </div>
            )}
        </div>
    );
}

/** A member row's group assignment: the toggle button and its click-to-open popover. */
export default function GroupAssignPopover({ userId, userGroups, orgGroups, groupsState, onCreateGroup }: GroupAssignPopoverProps) {
    const { t } = useTranslation();
    const { groupAssignOpenFor, setGroupAssignOpenFor, setGroupAssignSearch, groupAssignRef } = groupsState;
    const open = groupAssignOpenFor === userId;

    return (
        <div className="relative" ref={open ? groupAssignRef : null}>
            <button
                onClick={() => {
                    setGroupAssignOpenFor(prev => prev === userId ? null : userId);
                    setGroupAssignSearch('');
                }}
                className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg transition-colors ${open
                    ? 'bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}`}
                title={t('admin.org_assign_groups', 'Assign groups')}
            >
                <UserPlus className="w-3.5 h-3.5" />
                {userGroups.length > 0 && (
                    <span className="text-[10px] font-semibold">{userGroups.length}</span>
                )}
            </button>
            {open && (
                <GroupAssignMenu
                    userId={userId}
                    userGroups={userGroups}
                    orgGroups={orgGroups}
                    groupsState={groupsState}
                    onCreateGroup={onCreateGroup}
                />
            )}
        </div>
    );
}
