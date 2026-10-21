// The small pickers the answer checks share: a field of the answer, a list
// from an earlier step (with the part of each item that holds the value), and
// a number box. Controlled and free of step logic.
import { getList } from '@shared/expr/path.mjs';
import { useMemo, type ComponentType } from 'react';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import type { OnFocusField } from '../../../mapping/focusField.types';
import PathFieldJs from '../../../mapping/PathField';
import { collectArrayPaths } from '../../../mapping/upstream';
import { useVariablePickerContext } from '../../../mapping/VariablePickerContext';
import { FormRow, denseInputClass } from '../formPrimitives';
import type { FieldKind, FieldPathOption } from './reliabilityModel';

// A JavaScript component whose props TypeScript infers from their defaults.
export const PathField = PathFieldJs as unknown as ComponentType<Record<string, unknown>>;

export interface PickerProps {
    ariaBase: string;
    previewSample?: unknown;
    onFocusField?: OnFocusField | null;
}

/** A field of the answer in the reader's words. */
export function fieldOptionLabel(o: FieldPathOption, t: TranslateFn): string {
    if (o.each && o.column) return t('ai_step_checks.field_column_each', '{field}: {column} (each item)', { field: o.field, column: o.column });
    if (o.each) return t('ai_step_checks.field_each', '{field} (each item)', { field: o.field });
    if (o.column) return t('ai_step_checks.field_part', '{field}: {column}', { field: o.field, column: o.column });
    return o.field;
}

/** Which field of the answer the check looks at. Only fields of the right kind are offered. */
export function FieldSelect({ value, fields, kinds, onChange, ariaBase, label, hint }: {
    value: string; fields: FieldPathOption[]; kinds: FieldKind[]; onChange: (path: string) => void;
    ariaBase: string; label: string; hint: string;
}) {
    const { t } = useTranslation();
    const offered = fields.filter(f => kinds.includes(f.kind));
    const known = offered.some(f => f.path === value);
    return (
        <FormRow label={label} hint={hint}>
            <select aria-label={`${ariaBase} ${label}`} value={value} onChange={(e) => onChange(e.target.value)} className={denseInputClass('w-full')}>
                <option value="">{t('ai_step_checks.pick_field', 'Pick a field of the answer')}</option>
                {value && !known && <option value={value}>{value}</option>}
                {offered.map(f => <option key={f.path} value={f.path}>{fieldOptionLabel(f, t)}</option>)}
            </select>
        </FormRow>
    );
}

/** Keys of the first item of the sample list, when its items are records. */
function sampleKeys(list: unknown[] | null): string[] {
    const first = list?.[0];
    return first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first as Record<string, unknown>) : [];
}

/** A list from an earlier step, and which part of each item is the value. */
export function ListSourceField({ listRef, value, onChange, ariaBase, previewSample = null, onFocusField = null }: PickerProps & {
    listRef: string; value: string; onChange: (next: { ref: string; value: string }) => void;
}) {
    const { t } = useTranslation();
    const ctx = useVariablePickerContext();
    const sample = previewSample ?? ctx.previewSample;
    const quickPicks = useMemo(() => collectArrayPaths(ctx.groups as unknown as Parameters<typeof collectArrayPaths>[0], sample), [ctx.groups, sample]);
    const list = useMemo(() => (listRef && sample ? getList(sample, listRef) as unknown[] | null : null), [listRef, sample]);
    const keys = sampleKeys(list);
    return (
        <div className="space-y-2">
            <FormRow
                label={t('ai_step_checks.list_label', 'List of allowed values')}
                hint={list
                    ? t('ai_step_checks.list_count', '{n} in the example data.', { n: list.length })
                    : t('ai_step_checks.list_hint', 'Pick a list from an earlier step, for example the rows of a table or a column of a spreadsheet.')}
            >
                <PathField
                    value={listRef}
                    onChange={(v: string) => onChange({ ref: v.trim(), value })}
                    expectArray
                    quickPicks={quickPicks}
                    onFocusField={onFocusField}
                    previewSample={sample}
                    placeholder={t('ai_step_checks.no_list_yet', 'No list picked yet')}
                />
            </FormRow>
            <FormRow
                label={t('ai_step_checks.item_part_label', 'Part of each item')}
                hint={t('ai_step_checks.item_part_hint', 'Which part of each list item holds the value. Leave it empty when the list is plain text or numbers.')}
            >
                {keys.length > 0 ? (
                    <select aria-label={`${ariaBase} ${t('ai_step_checks.item_part_label', 'Part of each item')}`} value={value} onChange={(e) => onChange({ ref: listRef, value: e.target.value })} className={denseInputClass('w-full')}>
                        <option value="">{t('ai_step_checks.item_itself', 'The item itself')}</option>
                        {value && !keys.includes(value) && <option value={value}>{value}</option>}
                        {keys.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                ) : (
                    <input
                        type="text"
                        aria-label={`${ariaBase} ${t('ai_step_checks.item_part_label', 'Part of each item')}`}
                        value={value}
                        onChange={(e) => onChange({ ref: listRef, value: e.target.value.trim() })}
                        className={denseInputClass('w-full')}
                        placeholder={t('ai_step_checks.item_itself', 'The item itself')}
                    />
                )}
            </FormRow>
        </div>
    );
}

/** A whole-number or decimal box; empty is "not set". */
export function NumberBox({ value, onChange, label, hint, ariaLabel, min, max, step = 1, width = 'w-28' }: {
    value: number | undefined; onChange: (next: number | undefined) => void; label: string; hint?: string;
    ariaLabel: string; min?: number; max?: number; step?: number; width?: string;
}) {
    return (
        <FormRow label={label} hint={hint}>
            <input
                type="number"
                aria-label={ariaLabel}
                min={min}
                max={max}
                step={step}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
                className={denseInputClass(width)}
            />
        </FormRow>
    );
}

/** A tick with a one-line explanation under it. */
export function TickRow({ checked, onChange, label, hint, disabled = false }: {
    checked: boolean; onChange: (next: boolean) => void; label: string; hint?: string; disabled?: boolean;
}) {
    return (
        <label className={`flex items-start gap-2 text-xs ${disabled ? 'opacity-60' : ''}`}>
            <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <span>
                <span className="font-medium text-[var(--text-primary)]">{label}</span>
                {hint && <span className="block text-[var(--text-secondary)]">{hint}</span>}
            </span>
        </label>
    );
}
