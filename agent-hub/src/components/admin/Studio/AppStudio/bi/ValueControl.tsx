import useTranslation from '@/hooks/useTranslation';
import SegmentedControl from '@/components/shared/SegmentedControl';
import { INPUT_CLS } from '../inspector/panels/kit';
import type { ValueControlProps } from './FilterRowsEditor.types';
import { choicesOf, boolSegment } from './FilterRowsEditor.helpers';

export function ValueControl({ control, f, field, update }: ValueControlProps) {
    const { t } = useTranslation();
    if (control === 'bool') {
        return (
            <SegmentedControl
                value={boolSegment(f.value)}
                onChange={(v) => update({ ...f, value: v === 'true' })}
                options={[{ value: 'true', label: t('studio_apps_bi.params.yes', 'Yes') }, { value: 'false', label: t('studio_apps_bi.params.no', 'No') }]}
                size="sm"
                ariaLabel={t('studio_apps_bi.filter.value', 'Filter value')}
            />
        );
    }
    if (control === 'date' || control === 'datetime') {
        return (
            <input
                type={control === 'date' ? 'date' : 'datetime-local'}
                className={INPUT_CLS}
                value={typeof f.value === 'string' ? f.value : ''}
                onChange={(e) => update({ ...f, value: e.target.value })}
                aria-label={t('studio_apps_bi.filter.value', 'Filter value')}
            />
        );
    }
    if (control === 'number') {
        // Not type="number": a typed decimal comma (1,5) must survive — the
        // query builder parses it locale-aware before it reaches the server.
        return (
            <input
                type="text"
                inputMode="decimal"
                className={INPUT_CLS}
                value={String(f.value ?? '')}
                onChange={(e) => update({ ...f, value: e.target.value })}
                placeholder="0"
                aria-label={t('studio_apps_bi.filter.value', 'Filter value')}
            />
        );
    }
    if (control === 'choice') {
        const choices = choicesOf(field);
        const current = f.value == null ? '' : String(f.value);
        return (
            <select
                className={INPUT_CLS}
                value={choices.some((c) => c.value === current) ? current : ''}
                onChange={(e) => update({ ...f, value: e.target.value })}
                aria-label={t('studio_apps_bi.filter.value', 'Filter value')}
            >
                <option value="">{t('studio_apps_bi.filter.pick_one', 'Pick one…')}</option>
                {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
        );
    }
    if (control === 'list') {
        // `in` takes an array (queryCompiler caps it at MAX_IN_VALUES). Comma
        // separated is the shape people already type into a filter box; blanks
        // are dropped so a trailing comma is harmless.
        // A saved value that is not an array (a legacy row, or one written by
        // the raw-text escape this control no longer offers) is SHOWN rather
        // than hidden behind an empty box, and normalised to an array by the
        // next edit — `in` takes a list, and a string there matches nothing.
        const list = Array.isArray(f.value)
            ? f.value
            : (typeof f.value === 'string' && f.value
                ? f.value.split(',').map((x: string) => x.trim()).filter((x: string) => x !== '')
                : []);
        return (
            <input
                type="text"
                className={INPUT_CLS}
                value={list.join(', ')}
                onChange={(e) => update({
                    ...f,
                    value: e.target.value.split(',').map((s) => s.trim()).filter((s) => s !== ''),
                })}
                placeholder={t('studio_apps_bi.filter.list_placeholder', 'open, in progress, done')}
                aria-label={t('studio_apps_bi.filter.values', 'Filter values')}
            />
        );
    }
    if (control === 'range') {
        const pair = Array.isArray(f.value) && f.value.length === 2 ? f.value : ['', ''];
        const setAt = (i: number, v: string) => {
            const next = [pair[0], pair[1]];
            next[i] = v;
            update({ ...f, value: next });
        };
        const inputType = field?.type === 'date' ? 'date' : field?.type === 'datetime' ? 'datetime-local' : 'text';
        return (
            <div className="flex items-center gap-1.5 min-w-0">
                <input
                    type={inputType}
                    className={INPUT_CLS}
                    value={pair[0] ?? ''}
                    onChange={(e) => setAt(0, e.target.value)}
                    placeholder={t('studio_apps_bi.filter.from', 'From')}
                    aria-label={t('studio_apps_bi.filter.value_from', 'Filter value from')}
                />
                <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">{t('studio_apps_bi.filter.and', 'and')}</span>
                <input
                    type={inputType}
                    className={INPUT_CLS}
                    value={pair[1] ?? ''}
                    onChange={(e) => setAt(1, e.target.value)}
                    placeholder={t('studio_apps_bi.filter.to', 'To')}
                    aria-label={t('studio_apps_bi.filter.value_to', 'Filter value to')}
                />
            </div>
        );
    }
    return (
        <input
            type="text"
            className={INPUT_CLS}
            value={String(f.value ?? '')}
            onChange={(e) => update({ ...f, value: e.target.value })}
            placeholder={t('studio_apps_bi.filter.value_placeholder', 'Value')}
            aria-label={t('studio_apps_bi.filter.value', 'Filter value')}
        />
    );
}
