import React from 'react';
import { DATE_FORMATS, NUMBER_STYLES } from './valueParts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { controlSurfaceClass, denseInputClass } from '../flow/settings/formStyles';

// The separators the inline join editor offers — same wording as the chooser.
const JOIN_SEPARATORS = [
    { value: ', ', label: 'a comma and a space' },
    { value: ',', label: 'a comma' },
    { value: '; ', label: 'a semicolon' },
    { value: ' ', label: 'a space' },
    { value: '\n', label: 'a new line' },
];

interface TransformArgProps {
    transform: string | null;
    arg: string | null;
    arg2: string | null;
    onChange: (a: string | null, b: string | null) => void;
}

/**
 * The second half of a transform that carries one: join's separator,
 * formatNumber's style, formatDate's notation, yesNoText's two words
 * (artboard 2c). Renders nothing for the transforms that
 * take no argument, so the row stays one line for the common case.
 */
export default function TransformArg({ transform, arg, arg2, onChange }: TransformArgProps) {
    const { t } = useTranslation();
    if (transform === 'join') {
        const current = arg ?? ', ';
        const known = JOIN_SEPARATORS.some(s => s.value === current);
        return (
            <span className="flex items-center gap-1">
                {t('automations.builder.separated_by', 'Separated by')}
                <select
                    aria-label={t('automations.builder.separated_by', 'Separated by')}
                    value={known ? current : '__other__'}
                    onChange={(e) => { if (e.target.value !== '__other__') onChange(e.target.value, null); }}
                    className={controlSurfaceClass('px-1.5 py-0.5 text-[11px]')}
                >
                    {JOIN_SEPARATORS.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
                    {!known && <option value="__other__">{JSON.stringify(arg)}</option>}
                </select>
            </span>
        );
    }
    if (transform === 'formatNumber' || transform === 'formatDate') {
        const isDate = transform === 'formatDate';
        const options = isDate ? DATE_FORMATS : NUMBER_STYLES;
        const current = arg ?? options[0].value;
        const known = options.some(o => o.value === current);
        const label = isDate
            ? t('automations.builder.date_notation', 'Written as')
            : t('automations.builder.number_style', 'Shown as');
        return (
            <span className="flex items-center gap-1">
                {label}
                <select
                    aria-label={label}
                    value={known ? current : '__other__'}
                    onChange={(e) => { if (e.target.value !== '__other__') onChange(e.target.value, null); }}
                    className={controlSurfaceClass('px-1.5 py-0.5 text-[11px]')}
                >
                    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    {/* A hand-written notation stays selectable rather than
                        being silently replaced by the first preset. */}
                    {!known && <option value="__other__">{current}</option>}
                </select>
            </span>
        );
    }
    if (transform === 'yesNoText') {
        return (
            <span className="flex items-center gap-1">
                {t('automations.builder.yes_says', 'Yes says')}
                <input
                    type="text"
                    value={arg ?? 'yes'}
                    aria-label={t('automations.builder.yes_says', 'Yes says')}
                    onChange={(e) => onChange(e.target.value, arg2 ?? 'no')}
                    className={denseInputClass('w-20')}
                />
                {t('automations.builder.no_says', 'no says')}
                <input
                    type="text"
                    value={arg2 ?? 'no'}
                    aria-label={t('automations.builder.no_says', 'no says')}
                    onChange={(e) => onChange(arg ?? 'yes', e.target.value)}
                    className={denseInputClass('w-20')}
                />
            </span>
        );
    }
    return null;
}
