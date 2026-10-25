import { useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import ExpressionInput from '../../inspector/logic/ExpressionInput';
import BindingField from '../../inspector/panels/BindingField';
import { INPUT_CLS } from '../../inspector/panels/kit';
import { mergeDrafts, splitNamed, type RowDraft } from '../../inspector/keyedRows';
import type { RowBinding, RowValueFieldProps, KeyedBindingsFieldProps } from '../StepSettings.types';

function RowValueField({ shape, value, onChange, definition, node, formFields, disabled }: RowValueFieldProps) {
    const { t } = useTranslation();
    if (shape === 'recordValues') {
        return (
            <BindingField
                label={null}
                value={value}
                onChange={onChange}
                definition={definition}
                node={node}
                disabled={disabled}
            />
        );
    }

    // navigate params: a fixed value, or a formula worked out when it runs.
    if (shape === 'navParams') {
        const isFormula = value?.kind === 'formula';
        return (
            <div className="flex flex-col gap-1.5">
                <SegmentedControl
                    value={isFormula ? 'formula' : 'static'}
                    onChange={(next) => onChange(next === 'formula'
                        ? { kind: 'formula', expr: '' }
                        : { kind: 'static', value: '' })}
                    options={[{ value: 'static', label: t('studio_apps_edit.step_settings.fixed_value_option', 'A fixed value') }, { value: 'formula', label: t('studio_apps_edit.step_settings.worked_out', 'Worked out') }]}
                    size="sm"
                    ariaLabel={t('studio_apps_edit.step_settings.value_source', 'Where this value comes from')}
                />
                {isFormula ? (
                    <ExpressionInput
                        variant="inline"
                        value={value?.expr || ''}
                        onChange={(expr) => onChange({ kind: 'formula', expr })}
                        definition={definition}
                        node={node}
                        ariaLabel={t('studio_apps_edit.step_settings.value_formula', 'Value formula')}
                        disabled={disabled}
                    />
                ) : (
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={value?.value ?? ''}
                        onChange={(e) => onChange({ kind: 'static', value: e.target.value })}
                        disabled={disabled}
                        aria-label={t('studio_apps_edit.step_settings.fixed_value', 'Fixed value')}
                    />
                )}
            </div>
        );
    }

    // An automation's inputs: a fixed value, or one of the enclosing form's fields.
    const isField = value?.kind === 'field';
    return (
        <div className="flex flex-col gap-1.5">
            <SegmentedControl
                value={isField ? 'field' : 'static'}
                onChange={(next) => onChange(next === 'field'
                    ? { kind: 'field', name: formFields[0]?.name || '' }
                    : { kind: 'static', value: '' })}
                options={[{ value: 'static', label: t('studio_apps_edit.step_settings.fixed_value_option', 'A fixed value') }, { value: 'field', label: t('studio_apps_edit.step_settings.from_form', 'From the form') }]}
                size="sm"
                ariaLabel={t('studio_apps_edit.step_settings.value_source', 'Where this value comes from')}
            />
            {isField ? (
                <select
                    className={INPUT_CLS}
                    value={value?.name || ''}
                    onChange={(e) => onChange({ kind: 'field', name: e.target.value })}
                    disabled={disabled}
                    aria-label={t('studio_apps_edit.step_settings.form_field', 'Form field')}
                >
                    <option value="">{t('studio_apps_edit.step_settings.pick_field', 'Pick a field…')}</option>
                    {formFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                    {value?.name && !formFields.some((f) => f.name === value.name)
                        ? <option value={value.name}>{t('studio_apps_edit.step_settings.not_on_form', '{name} — not on this form', { name: value.name })}</option>
                        : null}
                </select>
            ) : (
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={value?.value ?? ''}
                    onChange={(e) => onChange({ kind: 'static', value: e.target.value })}
                    disabled={disabled}
                    aria-label={t('studio_apps_edit.step_settings.fixed_value', 'Fixed value')}
                />
            )}
        </div>
    );
}

export function KeyedBindingsField({ label, shape, value, onChange, definition, node, columns = [], required = false, formFields = [], disabled }: KeyedBindingsFieldProps) {
    const { t } = useTranslation();
    const stored: Array<[string, RowBinding]> = Object.entries(value && typeof value === 'object' ? value : {});
    // Rows the author has added or blanked but not yet named. Local, because
    // they cannot be represented in an object keyed by name — and held WITH
    // their position, or clearing a name would make the row jump to the bottom
    // of the list while the author was still typing in it.
    const [drafts, setDrafts] = useState<Array<RowDraft<[string, RowBinding]>>>([]);   // [{ at, row }]
    // The row whose rename was refused because the name is taken. UI only.
    const [clash, setClash] = useState<number | null>(null);

    const rows = mergeDrafts(stored, drafts);
    const commit = (next: Array<[string, RowBinding]>) => {
        setClash(null);
        const { named, drafts: nextDrafts } = splitNamed(next);
        setDrafts(nextDrafts);
        // Optional fields drop out entirely when empty; a required one stays as
        // an empty map so the definition keeps validating.
        onChange(named.length ? Object.fromEntries(named) : (required ? {} : undefined));
    };

    const setRowName = (i: number, name: string) => {
        if (name && rows.some(([n], j) => j !== i && n === name)) { setClash(i); return; }
        commit(rows.map<[string, RowBinding]>((r, j) => (j === i ? [name, r[1]] : r)));
    };

    const namePlaceholder = shape === 'recordValues' ? t('studio_apps_edit.step_settings.column_word', 'column') : t('studio_apps_edit.step_settings.name_word', 'name');
    const used = new Set(rows.map(([n]) => n));
    const nextColumn = columns.find((c) => !used.has(c.key))?.key || '';

    return (
        <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
            {rows.length === 0 ? (
                <p className="text-[11px] text-[var(--text-secondary)]">{t('studio_apps_edit.step_settings.nothing_set', 'Nothing set.')}</p>
            ) : null}
            {rows.map(([name, binding], i) => (
                <div key={i} className="rounded-md border border-[var(--border-subtle)] p-2 flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5">
                        {columns.length ? (
                            <select
                                className={INPUT_CLS}
                                value={name}
                                onChange={(e) => setRowName(i, e.target.value)}
                                disabled={disabled}
                                aria-label={t('studio_apps_edit.step_settings.row_name', '{label} {n} name', { label, n: i + 1 })}
                            >
                                <option value="">{t('studio_apps_edit.step_settings.pick_column', 'Pick a column…')}</option>
                                {columns.map((c) => (
                                    <option key={c.key} value={c.key} disabled={c.key !== name && used.has(c.key)}>
                                        {c.label}{c.required ? ' *' : ''}
                                    </option>
                                ))}
                                {name && !columns.some((c) => c.key === name)
                                    ? <option value={name}>{t('studio_apps_edit.step_settings.not_a_column', '{name} — not a column', { name })}</option>
                                    : null}
                            </select>
                        ) : (
                            <input
                                type="text"
                                className={INPUT_CLS}
                                value={name}
                                onChange={(e) => setRowName(i, e.target.value)}
                                placeholder={namePlaceholder}
                                disabled={disabled}
                                spellCheck={false}
                                aria-label={t('studio_apps_edit.step_settings.row_name', '{label} {n} name', { label, n: i + 1 })}
                            />
                        )}
                        <button
                            type="button"
                            onClick={() => commit(rows.filter((_, j) => j !== i))}
                            disabled={disabled}
                            aria-label={t('studio_apps_edit.step_settings.remove_row', 'Remove {label} {n}', { label: label.toLowerCase(), n: i + 1 })}
                            className="shrink-0 px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--error)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        >
                            {t('studio_apps_edit.step_settings.remove', 'Remove')}
                        </button>
                    </div>
                    {clash === i ? (
                        <span className="text-[11px] text-[var(--error)]" data-name-clash="true">
                            {t('studio_apps_edit.step_settings.name_clash', 'That name is already used above. Pick another one.')}
                        </span>
                    ) : null}
                    {!name ? (
                        <span className="text-[11px] text-[var(--text-tertiary)]">
                            {shape === 'recordValues'
                                ? t('studio_apps_edit.step_settings.give_column', 'Give this a column — it is not saved until you do.')
                                : t('studio_apps_edit.step_settings.give_name', 'Give this a name — it is not saved until you do.')}
                        </span>
                    ) : null}
                    <RowValueField
                        shape={shape}
                        value={binding}
                        onChange={(b) => commit(rows.map<[string, RowBinding]>((r, j) => (j === i ? [r[0], b as RowBinding] : r)))}
                        definition={definition}
                        node={node}
                        formFields={formFields}
                        disabled={disabled}
                    />
                </div>
            ))}
            <button
                type="button"
                onClick={() => commit([...rows, [columns.length ? nextColumn : '', { kind: 'static', value: '' }]])}
                disabled={disabled}
                className="self-start px-2.5 py-1 text-[11px] font-medium rounded border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
            >
                {t('studio_apps_edit.step_settings.add_one', 'Add one')}
            </button>
        </div>
    );
}
