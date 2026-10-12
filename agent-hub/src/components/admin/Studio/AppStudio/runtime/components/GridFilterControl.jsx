import { ChevronDown } from 'lucide-react';
import { FILTER_KIND } from './gridColumnFilters';
import useTranslation from '../../../../../../hooks/useTranslation';

/**
 * One column's filter control, shaped by the column's kind (see
 * gridColumnFilters.js): a contains box, a min–max pair, a from–to pair, a
 * yes/no pick or a value pick.
 *
 * Every variant is drawn as ONE bordered box so the filter row reads as a row
 * of equal cells rather than a mix of inputs and selects; a range is two bare
 * inputs inside that box with a dash between them. The box borrows the grid's
 * radius and turns the accent colour while it narrows anything, so a filter
 * that is set is visible from across the room.
 */

const BOX = 'flex items-center w-full min-w-0 border text-xs transition-colors focus-within:border-[var(--app-primary)]';
const boxStyle = (active) => ({
    background: 'var(--bg-primary)',
    borderColor: active ? 'var(--app-primary)' : 'var(--border-default)',
    borderRadius: 'var(--app-radius)',
    color: 'var(--text-primary)',
});
const FIELD = 'min-w-0 flex-1 bg-transparent px-1.5 py-0.5 text-xs outline-none placeholder:text-[var(--text-muted)]';
// A native <select> keeps its own arrow; hiding it and drawing one lets the
// box match the inputs beside it (and colour with the accent when active).
const SELECT = `${FIELD} appearance-none pr-5 cursor-pointer`;

function Dash() {
    return <span aria-hidden="true" className="shrink-0 select-none px-0.5" style={{ color: 'var(--text-muted)' }}>–</span>;
}

function Arrow() {
    return <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-1.5 h-3 w-3" style={{ color: 'var(--text-muted)' }} />;
}

export default function GridFilterControl({ kind, name, value, options, active, onChange }) {
    const { t } = useTranslation();
    const range = value && typeof value === 'object' ? value : {};
    const setPart = (part, v) => {
        const next = { ...range, [part]: v };
        // Both ends blank → no filter at all, not an empty object that
        // still counts as one.
        onChange(Object.values(next).some((x) => x !== '' && x != null) ? next : undefined);
    };

    if (kind === FILTER_KIND.number) {
        return (
            <div className={BOX} style={boxStyle(active)} role="group" aria-label={name}>
                <input
                    type="number" inputMode="decimal" placeholder={t('studio_apps_runtime.grid.filter_min', 'Min')}
                    aria-label={t('studio_apps_runtime.grid.filter_name_from', '{name} from', { name })}
                    value={range.min ?? ''}
                    onChange={(e) => setPart('min', e.target.value)}
                    className={FIELD}
                />
                <Dash />
                <input
                    type="number" inputMode="decimal" placeholder={t('studio_apps_runtime.grid.filter_max', 'Max')}
                    aria-label={t('studio_apps_runtime.grid.filter_name_to', '{name} to', { name })}
                    value={range.max ?? ''}
                    onChange={(e) => setPart('max', e.target.value)}
                    className={FIELD}
                />
            </div>
        );
    }

    if (kind === FILTER_KIND.date) {
        return (
            <div className={BOX} style={boxStyle(active)} role="group" aria-label={name}>
                <input
                    type="date"
                    aria-label={t('studio_apps_runtime.grid.filter_name_from', '{name} from', { name })}
                    value={range.from ?? ''}
                    onChange={(e) => setPart('from', e.target.value)}
                    className={FIELD}
                />
                <Dash />
                <input
                    type="date"
                    aria-label={t('studio_apps_runtime.grid.filter_name_to', '{name} to', { name })}
                    value={range.to ?? ''}
                    onChange={(e) => setPart('to', e.target.value)}
                    className={FIELD}
                />
            </div>
        );
    }

    if (kind === FILTER_KIND.boolean || kind === FILTER_KIND.select) {
        const items = kind === FILTER_KIND.boolean
            ? [{ value: 'true', label: t('studio_apps_runtime.grid.filter_yes_label', 'Yes') }, { value: 'false', label: t('studio_apps_runtime.grid.filter_no_label', 'No') }]
            : (options || []);
        return (
            <div className={`${BOX} relative`} style={boxStyle(active)}>
                <select
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value || undefined)}
                    aria-label={name}
                    className={SELECT}
                    style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
                >
                    <option value="">{kind === FILTER_KIND.boolean ? t('studio_apps_runtime.grid.filter_any', 'Any') : t('studio_apps_runtime.grid.filter_all', 'All')}</option>
                    {items.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
                </select>
                <Arrow />
            </div>
        );
    }

    return (
        <div className={BOX} style={boxStyle(active)}>
            <input
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value || undefined)}
                placeholder={t('studio_apps_runtime.grid.filter_contains', 'Contains…')}
                aria-label={name}
                className={FIELD}
            />
        </div>
    );
}
