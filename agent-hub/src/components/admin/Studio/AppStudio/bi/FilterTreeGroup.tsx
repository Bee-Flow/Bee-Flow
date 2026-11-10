import type { ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import { MAX_FILTER_DEPTH } from '@shared/expr/filterGroups.mjs';
import type { FilterAllGroupRow, FilterAnyGroupRow, FilterEntry, FilterGroupKind, FilterNotGroupRow, FilterRow } from './FilterRowsEditor.types';

/**
 * A group entry of a filter list (server/shared/expr/filterGroups.mjs):
 *   any   `{ any: [entry, …] }`   a row shows when ONE of them matches
 *   all   `{ all: [entry, …] }`   a row shows when ALL of them match (the
 *                                 "(a and b) or c" shape, inside an any group)
 *   none  `{ not: entry }`        a row shows when NONE of them matches; several
 *                                 entries are stored as `{ not: { any: [...] } }`
 * Groups nest MAX_FILTER_DEPTH deep. The entries are edited by the same row
 * editor as the top level, handed in as `renderMembers` so this file does not
 * import FilterRowsEditor back. A group that loses its last entry is removed
 * rather than saved empty (an empty group is a validation error).
 */

/** True for an OR group entry. */
function isAnyGroupRow(entry: FilterEntry): entry is FilterAnyGroupRow {
    return !!entry && typeof entry === 'object' && Array.isArray((entry as FilterAnyGroupRow).any);
}

const isAllGroupRow = (entry: FilterEntry): entry is FilterAllGroupRow =>
    !!entry && typeof entry === 'object' && Array.isArray((entry as FilterAllGroupRow).all) && (entry as Partial<FilterRow>).field === undefined;

const isNotGroupRow = (entry: FilterEntry): entry is FilterNotGroupRow => {
    const inner = (entry as FilterNotGroupRow | null)?.not;
    return !!inner && typeof inner === 'object' && !Array.isArray(inner) && (entry as Partial<FilterRow>).field === undefined;
};

/** The kind of group an entry is, or null for a row. */
export function groupKindOf(entry: FilterEntry): FilterGroupKind | null {
    if (isAnyGroupRow(entry)) return 'any';
    if (isAllGroupRow(entry)) return 'all';
    if (isNotGroupRow(entry)) return 'none';
    return null;
}

/** The entries a group shows: `{ not: { any: [...] } }` shows the list, `{ not: x }` shows x. */
export function membersOf(entry: FilterEntry, kind: FilterGroupKind): FilterEntry[] {
    if (kind === 'any') return (entry as FilterAnyGroupRow).any;
    if (kind === 'all') return (entry as FilterAllGroupRow).all;
    const inner = (entry as FilterNotGroupRow).not;
    return isAnyGroupRow(inner) ? inner.any : [inner];
}

/** The group with other entries; null when none are left (the group goes). */
function withMembers(entry: FilterEntry, kind: FilterGroupKind, members: FilterEntry[]): FilterEntry | null {
    if (members.length === 0) return null;
    if (kind === 'any') return { ...(entry as FilterAnyGroupRow), any: members };
    if (kind === 'all') return { ...(entry as FilterAllGroupRow), all: members };
    return { ...(entry as FilterNotGroupRow), not: members.length === 1 ? members[0] : { any: members } };
}

/**
 * Group levels a group takes for the entries inside it. A "none" group is
 * counted at two (`{ not: { any: [...] } }`), so a second entry always fits.
 */
const levelsOf = (kind: FilterGroupKind) => (kind === 'none' ? 2 : 1);

/**
 * The kinds of group that can be added to a list at `depth` inside
 * `parentKind`. An any group directly inside an any group (or inside a none
 * group, which stores its entries as one) is the same group, so it is not
 * offered; an all group at the top level is what the top level already is.
 */
export function addableGroupKinds(parentKind: FilterGroupKind | null, depth: number): FilterGroupKind[] {
    const fits = (kind: FilterGroupKind) => depth + levelsOf(kind) <= MAX_FILTER_DEPTH;
    const kinds: FilterGroupKind[] = parentKind === null ? ['any', 'none']
        : parentKind === 'all' ? ['any', 'none']
            : parentKind === 'any' ? ['all', 'none']
                : ['all'];
    return kinds.filter(fits);
}

/** A fresh group with one empty row. */
export function newGroup(kind: FilterGroupKind): FilterEntry {
    const row: FilterRow = { field: '', op: 'eq', value: '' };
    if (kind === 'any') return { any: [row] };
    if (kind === 'all') return { all: [row] };
    return { not: row };
}

interface FilterTreeGroupProps {
    entry: FilterEntry;
    kind: FilterGroupKind;
    /** Group levels above this group. */
    depth: number;
    onChange: (next: FilterEntry | null) => void;
    /** `maxItems` is set when the group has no level left for a second entry. */
    renderMembers: (members: FilterEntry[], onChange: (next: FilterEntry[]) => void, childDepth: number, maxItems: number | undefined) => ReactNode;
    allowRequired: boolean;
}

export function FilterTreeGroup({ entry, kind, depth, onChange, renderMembers, allowRequired }: FilterTreeGroupProps) {
    const { t } = useTranslation();
    const hint = kind === 'any' ? t('studio_apps_bi.filter.any_group_hint', 'A row shows when ONE of these matches.')
        : kind === 'all' ? t('studio_apps_filtertree.all_group_hint', 'A row shows when ALL of these match.')
            : t('studio_apps_filtertree.none_group_hint', 'A row shows when NONE of these matches.');
    const requiredLabel = kind === 'any'
        ? t('studio_apps_bi.filter.any_required_label', 'Show nothing until one of these has a value')
        : t('studio_apps_filtertree.group_required_label', 'Show nothing until these have a value');
    const group = entry as { required?: boolean };
    // `{ not: row }` is one level; a second entry makes it `{ not: { any } }`, which needs two.
    const single = kind === 'none' && depth + levelsOf(kind) > MAX_FILTER_DEPTH;
    return (
        <div className="flex flex-col gap-2 border-l-2 border-[var(--border-default)] pl-2">
            <p className="text-xs text-[var(--text-secondary)]">{hint}</p>
            {renderMembers(membersOf(entry, kind), (members) => onChange(withMembers(entry, kind, members)), depth + levelsOf(kind), single ? 1 : undefined)}
            {allowRequired ? (
                <Toggle
                    size="sm"
                    label={requiredLabel}
                    checked={!!group.required}
                    onChange={(v) => {
                        const { required: _drop, ...rest } = entry as FilterEntry & { required?: boolean };
                        onChange((v ? { ...rest, required: true } : rest) as FilterEntry);
                    }}
                    ariaLabel={requiredLabel}
                />
            ) : null}
        </div>
    );
}

/** The buttons under a filter list that add a group of each kind that fits there. */
export function AddGroupButtons({ kinds, onAdd }: { kinds: FilterGroupKind[]; onAdd: (kind: FilterGroupKind) => void }) {
    const { t } = useTranslation();
    const labelOf = (kind: FilterGroupKind) => (kind === 'any' ? t('studio_apps_bi.filter.add_any_group', 'Add an either/or group')
        : kind === 'all' ? t('studio_apps_filtertree.add_all_group', 'Add an all-of group')
            : t('studio_apps_filtertree.add_none_group', 'Add a none-of group'));
    return (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {kinds.map((kind) => (
                <button
                    key={kind}
                    type="button"
                    onClick={() => onAdd(kind)}
                    className="self-start text-xs text-[var(--accent-primary)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                >
                    {labelOf(kind)}
                </button>
            ))}
        </div>
    );
}

/** The name a group row carries in the list. */
export function useGroupLabel(): (kind: FilterGroupKind) => string {
    const { t } = useTranslation();
    return (kind) => (kind === 'any' ? t('studio_apps_bi.filter.any_group', 'Any of these')
        : kind === 'all' ? t('studio_apps_filtertree.all_group', 'All of these')
            : t('studio_apps_filtertree.none_group', 'None of these'));
}
