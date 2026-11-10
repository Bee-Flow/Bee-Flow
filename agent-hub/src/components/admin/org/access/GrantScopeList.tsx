// The scope column of the Grants matrix: "All members", then the groups
// (searchable once there are more than six), each with the number of
// capabilities granted to it. The current scope carries aria-current.

import { Search, Users } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { EYEBROW } from '@/components/mcpLibrary/ui';

interface ScopeButtonProps {
    label: string;
    count: number;
    active: boolean;
    onSelect: () => void;
}

function ScopeButton({ label, count, active, onSelect }: ScopeButtonProps) {
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-current={active ? 'true' : undefined}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${active
                ? 'bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'}`}
        >
            <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {count > 0 ? <span className="shrink-0 rounded-full bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)]">{count}</span> : null}
        </button>
    );
}

interface GrantScopeListProps {
    everyoneId: string;
    scope: string;
    onSelect: (id: string) => void;
    groups: readonly { id: string; name: string }[];
    filteredGroups: readonly { id: string; name: string }[];
    query: string;
    onQuery: (q: string) => void;
    grantCount: (id: string) => number;
}

export default function GrantScopeList({ everyoneId, scope, onSelect, groups, filteredGroups, query, onQuery, grantCount }: GrantScopeListProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-0.5 md:w-56 md:shrink-0">
            <ScopeButton label={t('admin_org.access_matrix_all_members', 'All members')} count={grantCount(everyoneId)} active={scope === everyoneId} onSelect={() => onSelect(everyoneId)} />
            <p className={`${EYEBROW} px-3 pb-1 pt-3`}>
                {t('admin_org.access_matrix_groups', 'Groups')} <span className="font-normal">({groups.length})</span>
            </p>
            {groups.length > 6 ? (
                <div className="relative mb-1">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <input
                        value={query}
                        onChange={e => onQuery(e.target.value)}
                        placeholder={t('admin_org.access_matrix_search_groups', 'Search groups…')}
                        className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] py-1.5 pl-8 pr-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent-primary)]"
                    />
                </div>
            ) : null}
            {groups.length === 0 ? (
                <p className="m-0 px-3 py-2 text-xs text-[var(--text-tertiary)]">
                    {t('admin_org.access_matrix_no_groups_a', 'No groups yet. Create groups under')} <strong>{t('admin_org.access_matrix_users_groups', 'Users & Groups')}</strong> {t('admin_org.access_matrix_no_groups_b', 'to grant capabilities per team.')}
                </p>
            ) : (
                <div className="flex flex-col gap-0.5 md:max-h-[460px] md:overflow-y-auto">
                    {filteredGroups.map(g => (
                        <ScopeButton key={g.id} label={g.name} count={grantCount(g.id)} active={scope === g.id} onSelect={() => onSelect(g.id)} />
                    ))}
                    {filteredGroups.length === 0
                        ? <p className="m-0 px-3 py-2 text-xs text-[var(--text-tertiary)]">{t('admin_org.access_matrix_no_groups_match', 'No groups match “{query}”.', { query })}</p>
                        : null}
                </div>
            )}
        </div>
    );
}
