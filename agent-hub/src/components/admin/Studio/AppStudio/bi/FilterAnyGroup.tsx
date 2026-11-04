import type { ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import type { FilterAnyGroupRow, FilterEntry, FilterRow } from './FilterRowsEditor.types';

/**
 * An `{ any: [clause, …] }` entry of a filter list: its clauses OR each other
 * and the group ANDs with the other entries (server/shared/expr/filterGroups.mjs).
 *
 * The clauses are edited by the same row editor as the top level, handed in
 * as `renderMembers` so this file does not import FilterRowsEditor back. A
 * group that loses its last clause is removed rather than saved empty (an
 * empty group is a validation error).
 */

/** True for an OR group entry. */
export function isAnyGroupRow(entry: FilterEntry): entry is FilterAnyGroupRow {
    return !!entry && typeof entry === 'object' && Array.isArray((entry as FilterAnyGroupRow).any);
}

/** A fresh group with one empty clause. */
export function newAnyGroup(): FilterAnyGroupRow {
    return { any: [{ field: '', op: 'eq', value: '' }] };
}

interface FilterAnyGroupProps {
    group: FilterAnyGroupRow;
    onChange: (next: FilterAnyGroupRow | null) => void;
    renderMembers: (members: FilterRow[], onChange: (next: FilterRow[]) => void) => ReactNode;
    allowRequired: boolean;
}

export function FilterAnyGroup({ group, onChange, renderMembers, allowRequired }: FilterAnyGroupProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2 border-l-2 border-[var(--border-default)] pl-2">
            <p className="text-xs text-[var(--text-secondary)]">
                {t('studio_apps_bi.filter.any_group_hint', 'A row shows when ONE of these matches.')}
            </p>
            {renderMembers(group.any, (members) => onChange(members.length ? { ...group, any: members } : null))}
            {allowRequired ? (
                <Toggle
                    size="sm"
                    label={t('studio_apps_bi.filter.any_required_label', 'Show nothing until one of these has a value')}
                    checked={!!group.required}
                    onChange={(v) => {
                        const { required: _drop, ...rest } = group;
                        onChange(v ? { ...rest, required: true } : rest);
                    }}
                    ariaLabel={t('studio_apps_bi.filter.any_required_label', 'Show nothing until one of these has a value')}
                />
            ) : null}
        </div>
    );
}

/** The button under a filter list that adds an either/or group. */
export function AddAnyGroupButton({ onAdd }: { onAdd: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onAdd}
            className="mt-1 self-start text-xs text-[var(--accent-primary)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
        >
            {t('studio_apps_bi.filter.add_any_group', 'Add an either/or group')}
        </button>
    );
}
