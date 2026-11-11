import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { inputCls } from '@/components/admin/product-website/fields';
import { cleanCurrency, cleanFormatOptions, FORMAT_LIMITS, PERCENT_SCALES } from '@shared/format/formatClean.mjs';
import { isDatePattern } from '@shared/format/datePattern.mjs';

/**
 * The editor's controls for a `formatOptions` object (schema 3): how one table or grid column,
 * a chart's value axis or a stat tile writes its numbers and dates.
 *
 * Every control starts empty, and empty means "as before": nothing is written for it. A change
 * goes through the same cleaner the server canonicalizes with (src/shared/format/), so what the
 * editor stores is already canonical; a shape left with no key is no shape (undefined), and the
 * caller drops the key (withFormatOptions).
 */

type Obj = Record<string, unknown>;

/** Which controls a value kind gets. Formats without numbers or dates get none. */
const FIELDS_BY_KIND: Readonly<Record<string, readonly string[]>> = Object.freeze({
    number: ['decimals', 'compact'],
    progress: ['decimals', 'compact'],
    currency: ['currency', 'decimals', 'compact'],
    percent: ['decimals', 'percentScale'],
    date: ['pattern'],
    datetime: ['pattern'],
    relative: ['pattern'],
    stat: ['currency', 'decimals', 'compact', 'percentScale'],
});

const DECIMAL_CHOICES = Array.from({ length: 7 }, (_, i) => i);

/** `obj` with `formatOptions` set to `next`, or without the key when `next` is undefined. */
export function withFormatOptions<T extends object>(obj: T, next: Obj | undefined): T {
    const rest: Obj = { ...(obj as Obj) };
    delete rest.formatOptions;
    return (next ? { ...rest, formatOptions: next } : rest) as T;
}

interface DraftFieldProps {
    label: string;
    value: unknown;
    /** The cleaned value, or undefined when the text cannot be used. */
    clean: (text: string) => unknown;
    onCommit: (value: unknown) => void;
    placeholder?: string;
    invalidText: string;
    hint?: string;
    listId?: string;
    disabled?: boolean;
}

/**
 * A text input that commits only a usable value (or nothing, when it is emptied). While the text
 * cannot be used it stays in the box, marked, and the stored value is left alone.
 */
export function DraftField({ label, value, clean, onCommit, placeholder, invalidText, hint, listId, disabled }: DraftFieldProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const stored = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const shown = draft ?? stored;
    const invalid = draft !== null && draft.trim() !== '' && clean(draft) === undefined;
    const change = (text: string) => {
        if (text.trim() === '') { setDraft(null); onCommit(undefined); return; }
        const cleaned = clean(text);
        if (cleaned === undefined) { setDraft(text); return; }
        setDraft(text === String(cleaned) ? null : text);
        onCommit(cleaned);
    };
    return (
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            <span>{label}</span>
            <input
                type="text"
                className={inputCls}
                value={shown}
                onChange={(e) => change(e.target.value)}
                onBlur={() => { if (!invalid) setDraft(null); }}
                placeholder={placeholder}
                list={listId}
                spellCheck={false}
                aria-invalid={invalid || undefined}
                aria-label={label}
                disabled={disabled}
            />
            {invalid ? <span className="text-[var(--error)]" role="alert">{invalidText}</span> : hint ? <span className="text-[var(--text-muted)]">{hint}</span> : null}
        </label>
    );
}

/** The date pattern help line, shared with the app-level Format section. */
export function patternHint(t: TranslateFn) {
    return t('studio_apps_format.pattern_hint', 'yyyy year, MM month, MMM month name, dd day, EEE weekday, HH:mm time. Put other letters in single quotes.');
}

export const cleanPatternText = (text: string) => (isDatePattern(text.trim()) ? text.trim() : undefined);

interface FormatOptionsFieldsProps {
    /** The value kind: a column's format, a chart's valueFormat, or 'stat'. */
    kind: string | undefined;
    value: unknown;
    onChange: (next: Obj | undefined) => void;
    disabled?: boolean;
}

export default function FormatOptionsFields({ kind, value, onChange, disabled = false }: FormatOptionsFieldsProps) {
    const { t } = useTranslation();
    const fields = FIELDS_BY_KIND[kind || ''] || [];
    if (!fields.length) return null;
    const current: Obj = value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
    const set = (key: string, next: unknown) => {
        const draft: Obj = { ...current, [key]: next };
        if (next === undefined || next === '') delete draft[key];
        onChange(cleanFormatOptions(draft) as Obj | undefined);
    };
    const has = (key: string) => fields.includes(key);
    return (
        <div className="grid grid-cols-2 gap-2" data-format-options={kind}>
            {has('currency') ? (
                <DraftField
                    label={t('studio_apps_format.currency', 'Currency')}
                    value={current.currency}
                    clean={cleanCurrency}
                    onCommit={(v) => set('currency', v)}
                    placeholder={t('studio_apps_format.currency_placeholder', 'App default')}
                    invalidText={t('studio_apps_format.currency_invalid', 'Use a three-letter code such as USD.')}
                    disabled={disabled}
                />
            ) : null}
            {has('decimals') ? <DecimalsSelect t={t} value={current.decimals} onChange={(v) => set('decimals', v)} disabled={disabled} /> : null}
            {has('percentScale') ? <PercentScaleSelect t={t} value={current.percentScale} onChange={(v) => set('percentScale', v)} disabled={disabled} /> : null}
            {has('pattern') ? (
                <div className="col-span-2">
                    <DraftField
                        label={t('studio_apps_format.pattern', 'Date pattern')}
                        value={current.pattern}
                        clean={cleanPatternText}
                        onCommit={(v) => set('pattern', v)}
                        placeholder={t('studio_apps_format.pattern_placeholder', 'dd-MM-yyyy')}
                        hint={patternHint(t)}
                        invalidText={t('studio_apps_format.pattern_invalid', 'A letter here is not a date part. Put text in single quotes.')}
                        disabled={disabled}
                    />
                </div>
            ) : null}
            {has('compact') ? (
                <label className="col-span-2 inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <input
                        type="checkbox"
                        checked={current.compact === true}
                        onChange={(e) => set('compact', e.target.checked ? true : undefined)}
                        className="accent-[var(--accent-primary)]"
                        disabled={disabled}
                    />
                    {t('studio_apps_format.compact', 'Short numbers (1.2K, 3.4M)')}
                </label>
            ) : null}
        </div>
    );
}

interface SelectProps {
    t: TranslateFn;
    value: unknown;
    onChange: (value: unknown) => void;
    disabled: boolean;
}

/** Decimals: empty is the default for the kind. Shared with the app section (currencyDecimals). */
export function DecimalsSelect({ t, value, onChange, disabled, label }: SelectProps & { label?: string }) {
    const text = label || t('studio_apps_format.decimals', 'Decimals');
    return (
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            <span>{text}</span>
            <select
                className={inputCls}
                value={typeof value === 'number' ? String(value) : ''}
                onChange={(e) => onChange(e.target.value === '' ? undefined : Math.min(FORMAT_LIMITS.MAX_DECIMALS, Number(e.target.value)))}
                aria-label={text}
                disabled={disabled}
            >
                <option value="">{t('studio_apps_format.default', 'Default')}</option>
                {DECIMAL_CHOICES.map((n) => <option key={n} value={String(n)}>{String(n)}</option>)}
            </select>
        </label>
    );
}

function PercentScaleSelect({ t, value, onChange, disabled }: SelectProps) {
    const labels: Record<string, string> = {
        whole: t('studio_apps_format.percent_whole', '25 means 25%'),
        fraction: t('studio_apps_format.percent_fraction', '0.25 means 25%'),
    };
    const text = t('studio_apps_format.percent_scale', 'Stored as');
    return (
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            <span>{text}</span>
            <select
                className={inputCls}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(e.target.value || undefined)}
                aria-label={text}
                disabled={disabled}
            >
                <option value="">{t('studio_apps_format.default', 'Default')}</option>
                {PERCENT_SCALES.map((s) => <option key={s} value={s}>{labels[s] || s}</option>)}
            </select>
        </label>
    );
}
