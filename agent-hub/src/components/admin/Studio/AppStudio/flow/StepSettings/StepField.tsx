import { AlertTriangle, Workflow } from 'lucide-react';
import { useState } from 'react';
import { columnOptions, isDanglingRef, labelForRef, REFERENCE_EMPTY_HINTS, REFERENCE_FIELDS, REFERENCE_PLACEHOLDERS, referenceText } from '../stepReferences';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import Toggle from '../../../../../shared/Toggle';
import ExpressionInput from '../../inspector/logic/ExpressionInput';
import BindingField from '../../inspector/panels/BindingField';
import { INPUT_CLS } from '../../inspector/panels/kit';
import AutomationPicker from '../../inspector/AutomationPicker';
import type { TranslateParams } from '../../../../../../hooks/useTranslation';
import type { RowBinding, SwitchCase, Placeholder, StepFieldProps, ReferenceFieldProps, AutomationRefFieldProps, SwitchCasesFieldProps } from '../StepSettings.types';
import { FIELD_LABELS, HINTS } from './StepSettings.constants';
import { KeyedBindingsField } from './KeyedBindingsField';

/** 'screenId' → 'Screen', 'maxIterations' → 'Max iterations'. */
function humanize(key: string) {
    const words = String(key)
        .replace(/Id$/, '')
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StepField({
    fieldKey, fs, value, step, onChange, definition, node, options, references, formFields, disabled,
}: StepFieldProps) {
    const { t } = useTranslation();
    const labelEntry = FIELD_LABELS[fieldKey];
    const label = labelEntry ? t(labelEntry[0], labelEntry[1]) : humanize(fieldKey);
    const hintEntry = HINTS[fieldKey];
    const hint = hintEntry ? t(hintEntry[0], hintEntry[1]) : undefined;
    const required = !!fs.required;

    // Every reference is a pick, never a typed id.
    const refKind = REFERENCE_FIELDS[fieldKey];
    if (refKind) {
        // An automation is chosen from the searchable picker the inspector already
        // uses for the bare `run_automation` action — same job, same affordance.
        if (refKind === 'automation') {
            return (
                <AutomationRefField
                    label={label}
                    hint={hint}
                    value={value as string}
                    onChange={onChange}
                    options={options.automation}
                    formFields={formFields}
                    disabled={disabled}
                />
            );
        }
        return (
            <ReferenceField
                label={label}
                hint={hint}
                kind={refKind}
                value={value as string}
                onChange={onChange}
                options={options[refKind] || []}
                disabled={disabled}
            />
        );
    }

    switch (fs.type) {
        case 'formula':
            return (
                <FormField label={label} hint={hint}>
                    <ExpressionInput
                        value={(value || '') as string}
                        onChange={onChange}
                        definition={definition}
                        node={node}
                        ariaLabel={label}
                        expectsBoolean={fieldKey === 'expr'}
                        placeholder={t('studio_apps_edit.step_settings.formula_example', "e.g. vars.status == 'open'")}
                        disabled={disabled}
                    />
                </FormField>
            );
        case 'binding':
            return (
                <BindingField
                    label={label}
                    hint={hint}
                    value={value}
                    onChange={onChange}
                    definition={definition}
                    node={node}
                    disabled={disabled}
                />
            );
        case 'enum':
            return (
                <FormField label={label} hint={hint}>
                    <select
                        className={INPUT_CLS}
                        value={(value ?? fs.default ?? '') as string}
                        onChange={(e) => onChange(e.target.value)}
                        disabled={disabled}
                        aria-label={label}
                    >
                        {(fs.values || []).map((v) => <option key={String(v)} value={v}>{humanize(String(v))}</option>)}
                    </select>
                </FormField>
            );
        case 'boolean':
            return (
                <Toggle
                    size="sm"
                    label={label}
                    description={hint}
                    checked={(value ?? fs.default ?? false) as boolean}
                    onChange={onChange}
                    ariaLabel={label}
                    disabled={disabled}
                />
            );
        case 'int':
            return (
                <FormField label={label} hint={hint}>
                    <input
                        type="number"
                        className={INPUT_CLS}
                        value={(value ?? '') as number | string}
                        min={fs.min}
                        max={fs.max}
                        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
                        disabled={disabled}
                        aria-label={label}
                    />
                </FormField>
            );
        case 'switchCases':
            return <SwitchCasesField label={t('studio_apps_edit.step_settings.cases', 'Cases')} value={value as SwitchCase[] | undefined} onChange={onChange} disabled={disabled} />;
        case 'navParams':
        case 'recordValues':
        case 'inputMapping':
            return (
                <KeyedBindingsField
                    label={label}
                    shape={fs.type}
                    value={value as Record<string, RowBinding> | null | undefined}
                    onChange={onChange}
                    definition={definition}
                    node={node}
                    // A record's values are addressed by COLUMN, and the step
                    // already names the table — so offer its columns instead of
                    // asking for one to be spelled correctly from memory.
                    // A fill_document's values are addressed by PLACEHOLDER, not
                    // by column: the same "offer what the target actually has"
                    // rule, against the document the step already names. Without
                    // this branch the author types placeholder names from memory
                    // into a step whose whole failure mode is a name that matches
                    // no hole — which prints a blank line on an invoice.
                    columns={fs.type !== 'recordValues'
                        ? []
                        : (step?.kind === 'fill_document'
                            ? placeholderOptions(references.placeholdersFor?.(step?.documentId), t)
                            : columnOptions(references.fieldsFor(step?.tableId as string | undefined)))}
                    required={required}
                    formFields={formFields}
                    disabled={disabled}
                />
            );
        case 'url':
        case 'string':
        default:
            return (
                <FormField label={label} hint={hint}>
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={(value ?? '') as string}
                        onChange={(e) => onChange(e.target.value || (fs.nullable ? null : ''))}
                        placeholder={required ? t('studio_apps_edit.step_settings.required', 'Required') : undefined}
                        maxLength={fs.maxLen}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={label}
                    />
                </FormField>
            );
    }
}

/**
 * A document's placeholders as picker rows, in the shape KeyedBindingsField's
 * `columns` takes. A list placeholder says so and names the fields each item
 * needs — that is the one binding with a rule (a whole array, never text).
 */
function placeholderOptions(placeholders: unknown, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    return (Array.isArray(placeholders) ? placeholders : [])
        .filter((p: Placeholder) => p && typeof p.key === 'string')
        .map((p: Placeholder) => ({
            key: p.key,
            label: p.kind === 'list'
                ? (p.fields?.length
                    ? t('studio_apps_edit.step_settings.placeholder_list_of', '{key} (list of {fields})', { key: p.key, fields: p.fields.join(', ') })
                    : t('studio_apps_edit.step_settings.placeholder_list', '{key} (list)', { key: p.key }))
                : (p.kind === 'condition' ? t('studio_apps_edit.step_settings.placeholder_condition', '{key} (shown only if set)', { key: p.key }) : p.key),
        }));
}

function ReferenceField({ label, hint, kind, value, onChange, options, disabled }: ReferenceFieldProps) {
    const { t } = useTranslation();
    const dangling = isDanglingRef(options, value);
    const empty = options.length === 0;

    return (
        <FormField label={label} hint={hint}>
            <select
                className={INPUT_CLS}
                value={value || ''}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                aria-label={label}
                aria-invalid={dangling ? 'true' : undefined}
            >
                <option value="">{referenceText(REFERENCE_PLACEHOLDERS[kind], t) || t('studio_apps_edit.step_settings.pick_one', 'Pick one…')}</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                {dangling ? <option value={value}>{t('studio_apps_edit.step_settings.value_missing', '{value} — missing', { value })}</option> : null}
            </select>
            {dangling ? (
                <span className="mt-1 flex items-center gap-1 text-[11px] text-[var(--error)]" data-ref-missing="true">
                    <AlertTriangle size={11} aria-hidden="true" />
                    {t('studio_apps_edit.step_settings.ref_missing', 'This no longer exists. Pick another one.')}
                </span>
            ) : empty ? (
                <span className="mt-1 block text-[11px] text-[var(--text-secondary)]">
                    {referenceText(REFERENCE_EMPTY_HINTS[kind], t)}
                </span>
            ) : null}
        </FormField>
    );
}

function AutomationRefField({ label, hint, value, onChange, options, formFields, disabled }: AutomationRefFieldProps) {
    const { t } = useTranslation();
    const [picking, setPicking] = useState(false);
    const name = value ? labelForRef(options, value) : '';
    const dangling = isDanglingRef(options, value);

    return (
        <FormField label={label} hint={hint}>
            <button
                type="button"
                onClick={() => setPicking(true)}
                disabled={disabled}
                aria-label={label}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md border text-left transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] ${
                    dangling ? 'border-[var(--error)]' : 'border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]'
                } bg-[var(--bg-secondary)]`}
            >
                <Workflow className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <span className={`flex-1 min-w-0 truncate ${name ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                    {name || referenceText(REFERENCE_PLACEHOLDERS.automation, t)}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">{value ? t('studio_apps_edit.step_settings.change', 'Change') : ''}</span>
            </button>
            {dangling ? (
                <span className="mt-1 flex items-center gap-1 text-[11px] text-[var(--error)]" data-ref-missing="true">
                    <AlertTriangle size={11} aria-hidden="true" />
                    {t('studio_apps_edit.step_settings.automation_missing', 'This automation no longer exists. Pick another one.')}
                </span>
            ) : null}
            <AutomationPicker
                open={picking}
                onClose={() => setPicking(false)}
                formFields={formFields}
                onPick={(automation) => { setPicking(false); onChange(automation?.id || ''); }}
            />
        </FormField>
    );
}

function SwitchCasesField({ label, value, onChange, disabled }: SwitchCasesFieldProps) {
    const { t } = useTranslation();
    const cases: SwitchCase[] = Array.isArray(value) ? value : [];
    const commit = (next: SwitchCase[]) => onChange(next);

    return (
        <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('studio_apps_edit.step_settings.cases_help', 'Each case runs when the value above equals what you type here. Anything that matches nothing runs “Otherwise”.')}
            </p>
            {cases.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5">
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={c?.value ?? ''}
                        onChange={(e) => commit(cases.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                        placeholder={t('studio_apps_edit.step_settings.case_example', 'e.g. paid')}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={t('studio_apps_edit.step_settings.case_value', 'Case {n} value', { n: i + 1 })}
                    />
                    <button
                        type="button"
                        onClick={() => commit(cases.filter((_, j) => j !== i))}
                        disabled={disabled}
                        aria-label={t('studio_apps_edit.step_settings.remove_case', 'Remove case {n}', { n: i + 1 })}
                        className="shrink-0 px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--error)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                    >
                        {t('studio_apps_edit.step_settings.remove', 'Remove')}
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={() => commit([...cases, { value: '', steps: [] }])}
                disabled={disabled}
                className="self-start px-2.5 py-1 text-[11px] font-medium rounded border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
            >
                {t('studio_apps_edit.step_settings.add_case', 'Add a case')}
            </button>
        </div>
    );
}
