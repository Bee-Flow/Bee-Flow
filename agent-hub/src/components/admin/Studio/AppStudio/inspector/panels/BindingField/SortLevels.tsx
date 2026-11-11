import { X } from 'lucide-react';
import { INPUT_CLS } from '../kit';
import useTranslation from '@/hooks/useTranslation';
import type { FilterField } from '@/components/admin/Studio/AppStudio/bi/FilterRowsEditor.types';
import type { BindingDraft } from '../BindingField.types';
import { normSort } from './BindingField.helpers';

/**
 * The sort of a table binding, on up to three columns.
 *
 * One column is stored as `sort: [{ field, dir }]`, as it always was. A second
 * or third makes it `orderBy: [{ field, dir }, …]` (and removes `sort`): the
 * server reads only the first entry of a `sort` list, `orderBy` is the key
 * that sorts on every column it names (queryCompilerOrder.mts).
 */

/** Sort levels a binding may carry (queryCompilerOrder.MAX_ORDER_BY). */
const MAX_SORT_LEVELS = 3;

interface SortLevel { field: string; dir: string }

const dirOf = (entry: { dir?: unknown; direction?: unknown }) => (String(entry.dir || entry.direction || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc');

/** The levels a binding sorts on: its `orderBy`, else the one entry of its `sort`. */
export function sortLevelsOf(binding: Pick<BindingDraft, 'sort' | 'orderBy'>): SortLevel[] {
    if (Array.isArray(binding.orderBy) && binding.orderBy.length) {
        return (binding.orderBy as Array<{ field?: unknown; dir?: unknown; direction?: unknown }>)
            .filter((e) => e && typeof e.field === 'string')
            .map((e) => ({ field: e.field as string, dir: dirOf(e) }));
    }
    const one = normSort(binding.sort);
    return one?.field ? [{ field: one.field, dir: one.dir || 'asc' }] : [];
}

/** The `sort` / `orderBy` keys for these levels: nothing, a plain `sort`, or an `orderBy`. */
export function sortPatchFor(levels: SortLevel[]): { sort: unknown; orderBy: unknown } {
    const named = levels.filter((l) => l.field);
    if (named.length === 0) return { sort: undefined, orderBy: undefined };
    if (named.length === 1) return { sort: [named[0]], orderBy: undefined };
    return { sort: undefined, orderBy: named.slice(0, MAX_SORT_LEVELS) };
}

const DirectionOptions = () => {
    const { t } = useTranslation();
    return (
        <>
            <option value="asc">{t('studio_apps_panels.binding.sort_asc', 'Ascending')}</option>
            <option value="desc">{t('studio_apps_panels.binding.sort_desc', 'Descending')}</option>
        </>
    );
};

const FieldOptions = ({ options }: { options: FilterField[] }) => (
    <>{options.map((option) => <option key={option.key} value={option.key}>{option.name || option.key}</option>)}</>
);

interface ThenLevelProps {
    level: SortLevel;
    /** 2 or 3: the level as the author counts it. */
    n: number;
    options: FilterField[];
    onChange: (patch: Partial<SortLevel>) => void;
    onRemove: () => void;
    disabled?: boolean;
}

/** One "then by" level: its field, its direction and the button that removes it. */
function ThenLevel({ level, n, options, onChange, onRemove, disabled }: ThenLevelProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-stretch gap-2">
            <select
                className={`${INPUT_CLS} min-w-0 flex-1`}
                value={level.field}
                onChange={(e) => onChange({ field: e.target.value })}
                disabled={disabled}
                aria-label={t('studio_apps_filtertree.sort_then_field', 'Then sort by, level {n}', { n })}
            >
                <FieldOptions options={options} />
            </select>
            <select
                className={`${INPUT_CLS} min-w-0 flex-1`}
                value={level.dir}
                onChange={(e) => onChange({ dir: e.target.value })}
                disabled={disabled}
                aria-label={t('studio_apps_filtertree.sort_then_direction', 'Direction of sort level {n}', { n })}
            >
                <DirectionOptions />
            </select>
            <button
                type="button"
                onClick={onRemove}
                disabled={disabled}
                aria-label={t('studio_apps_filtertree.sort_remove_level', 'Remove sort level {n}', { n })}
                className="shrink-0 px-2 rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
            >
                <X size={13} />
            </button>
        </div>
    );
}

interface SortLevelsProps {
    binding: BindingDraft;
    fields: FilterField[];
    onPatch: (patch: { sort: unknown; orderBy: unknown }) => void;
    disabled?: boolean;
}

export function SortLevels({ binding, fields, onPatch, disabled }: SortLevelsProps) {
    const { t } = useTranslation();
    const levels = sortLevelsOf(binding);
    const first = levels[0] || null;
    const write = (next: SortLevel[]) => onPatch(sortPatchFor(next));
    const setLevel = (i: number, patch: Partial<SortLevel>) => write(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    // A column sorts once: each level offers what the others did not take.
    const freeFor = (i: number) => fields.filter((option) => !levels.some((l, j) => j !== i && l.field === option.key));
    const nextFree = freeFor(levels.length)[0];
    const canAdd = !!first && levels.length < MAX_SORT_LEVELS && !!nextFree;

    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
                <select
                    className={INPUT_CLS}
                    value={first?.field || ''}
                    onChange={(e) => write(e.target.value ? [{ field: e.target.value, dir: first?.dir || 'asc' }, ...levels.slice(1)] : [])}
                    disabled={disabled}
                    aria-label={t('studio_apps_panels.binding.sort_field', 'Sort field')}
                >
                    <option value="">{t('studio_apps_panels.binding.no_sort', 'No sort')}</option>
                    <FieldOptions options={freeFor(0)} />
                </select>
                <select
                    className={INPUT_CLS}
                    value={first?.dir || 'asc'}
                    onChange={(e) => setLevel(0, { dir: e.target.value })}
                    disabled={disabled || !first}
                    aria-label={t('studio_apps_panels.binding.sort_direction', 'Sort direction')}
                >
                    <DirectionOptions />
                </select>
            </div>
            {levels.slice(1).map((level, k) => (
                <ThenLevel
                    key={level.field} level={level} n={k + 2} options={freeFor(k + 1)} disabled={disabled}
                    onChange={(patch) => setLevel(k + 1, patch)} onRemove={() => write(levels.filter((_, j) => j !== k + 1))}
                />
            ))}
            {canAdd ? (
                <button
                    type="button"
                    onClick={() => write([...levels, { field: nextFree.key, dir: 'asc' }])}
                    disabled={disabled}
                    className="self-start text-xs text-[var(--accent-primary)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                >
                    {t('studio_apps_filtertree.sort_add_level', 'Then sort by another field')}
                </button>
            ) : null}
            {levels.length > 1 ? (
                <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_filtertree.sort_levels_hint', 'Rows with an empty value come last in each level.')}</p>
            ) : null}
        </div>
    );
}
