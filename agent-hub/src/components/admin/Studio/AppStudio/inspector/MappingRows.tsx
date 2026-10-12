import { X } from 'lucide-react';
import React, { useState } from 'react';
import type { FormFieldRef, InputMapping, ParamMeta, ParamMetaByName } from './appDefinition';
import { INPUT_CLS } from './panels/kit';
import useTranslation from '../../../../../hooks/useTranslation';
import IconButton from '../../../../shared/IconButton';
import SegmentedControl from '../../../../shared/SegmentedControl';

// ── Input mapping (run_automation) ─────────────────────────────────────────



/**
 * What the automation expects now, versus what this action sends.
 *
 * An automation's inputs change after it is wired: a param gets added, renamed or
 * dropped. Nothing said so — a missing input arrived as undefined and the
 * automation ran with a hole in it, while an input the automation no longer has was
 * posted and ignored. Both are silent, and both look like the automation is
 * broken.
 *
 * Only rendered when the target declares a contract at all (app_trigger's typed
 * params, or agent_call's schema); an automation with no contract can take anything.
 */
export interface ContractDriftProps {
    /** Null when the target declares no contract — it can then take anything. */
    paramMeta: ParamMetaByName | null;
    /** The parameter names this action currently sends. */
    mapped: string[];
    onAdd: (name: string) => void;
    onRemove: (name: string) => void;
    disabled?: boolean;
}

export function ContractDrift({ paramMeta, mapped, onAdd, onRemove, disabled }: ContractDriftProps) {
    const { t } = useTranslation();
    if (!paramMeta) return null;
    const declared = Object.keys(paramMeta);
    const missing = declared.filter((name) => !mapped.includes(name));
    const extra = mapped.filter((name) => name && !declared.includes(name));
    if (!missing.length && !extra.length) return null;

    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--warning)] p-2">
            {missing.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-[var(--text-primary)]">
                        {t('studio_apps_insp.mapping.also_expects', 'The automation also expects:')}
                    </span>
                    {missing.map((name) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => onAdd(name)}
                            disabled={disabled}
                            className="px-1.5 py-0.5 rounded text-[11px] font-mono border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                            title={paramMeta[name].required ? t('studio_apps_insp.mapping.required_by_automation', 'Required by the automation') : t('studio_apps_insp.mapping.optional', 'Optional')}
                        >
                            + {name}{paramMeta[name].required ? ' *' : ''}
                        </button>
                    ))}
                </div>
            ) : null}
            {extra.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-[var(--text-primary)]">
                        {t('studio_apps_insp.mapping.no_longer_takes', 'The automation no longer takes:')}
                    </span>
                    {extra.map((name) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => onRemove(name)}
                            disabled={disabled}
                            className="px-1.5 py-0.5 rounded text-[11px] font-mono border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--error)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                            title={t('studio_apps_insp.mapping.sent_ignored', 'Sent, and ignored')}
                        >
                            {name} ✕
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

/**
 * One inputMapping row. `paramMeta` ({ type, required, description? } | null)
 * comes from the target automation's DECLARED contract (app_trigger trigger.params
 * or agent_call schema): it renders a type badge, and a `file` param locks the
 * row to form-field mode filtered to file-upload inputs (a static string can
 * never become a file).
 */
export interface MappingRowProps {
    /** The parameter this row feeds. */
    param: string;
    mapping: InputMapping | null | undefined;
    /** Input fields of the enclosing form; empty when there is no form. */
    formFields: FormFieldRef[];
    onChange: (mapping: InputMapping) => void;
    onRename: (name: string) => void;
    onRemove: () => void;
    disabled?: boolean;
    /** This parameter's declared contract, when the target has one. */
    paramMeta?: ParamMeta | null;
    /** The other rows' names — a rename onto one of them is refused. */
    takenNames?: string[];
}

export function MappingRow({
    param, mapping, formFields, onChange, onRename, onRemove, disabled,
    paramMeta = null, takenNames = [],
}: MappingRowProps) {
    const { t } = useTranslation();
    const mappingModes = [
        { value: 'field', label: t('studio_apps_insp.mapping.mode_field', 'Form field') },
        { value: 'static', label: t('studio_apps_insp.mapping.mode_static', 'Static') },
    ];
    // The name is typed locally: renaming onto another parameter would drop
    // that parameter's mapping, so a clashing draft is shown but not committed.
    const [draftName, setDraftName] = useState(param);
    const [syncedParam, setSyncedParam] = useState(param);
    if (syncedParam !== param) {
        setSyncedParam(param);
        setDraftName(param);
    }
    const clash = draftName !== param && (!draftName.trim() || takenNames.includes(draftName));
    const isFile = paramMeta?.type === 'file';
    const mode = isFile ? 'field' : (mapping?.kind === 'field' ? 'field' : 'static');
    const candidates = isFile ? formFields.filter((f) => f.type === 'input_file') : formFields;
    const fieldNames = candidates.map((f) => f.name);
    const selectedField = mode === 'field' ? formFields.find((f) => f.name === mapping?.name) : null;
    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    className={`${INPUT_CLS} font-mono text-xs`}
                    value={draftName}
                    onChange={(e) => {
                        const next = e.target.value;
                        setDraftName(next);
                        if (next.trim() && !takenNames.includes(next)) onRename(next);
                    }}
                    placeholder={t('studio_apps_insp.mapping.parameter_placeholder', 'Parameter')}
                    disabled={disabled}
                    spellCheck={false}
                    aria-label={t('studio_apps_insp.mapping.parameter_name_aria', 'Parameter name')}
                />
                {paramMeta ? (
                    <span
                        className="shrink-0 px-1.5 py-0.5 rounded text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)]"
                        title={paramMeta.description || undefined}
                    >
                        {paramMeta.type}{paramMeta.required ? '*' : ''}
                    </span>
                ) : null}
                <IconButton ariaLabel={t('studio_apps_insp.mapping.remove_parameter', 'Remove parameter {param}', { param })} onClick={onRemove} disabled={disabled} variant="danger" size="sm">
                    <X />
                </IconButton>
            </div>
            {clash ? (
                <p className="text-xs text-rose-500">
                    {draftName.trim()
                        ? t('studio_apps_insp.mapping.name_taken', 'There is already a parameter called “{name}” — pick another name.', { name: draftName })
                        : t('studio_apps_insp.mapping.name_required', 'A parameter needs a name.')}
                </p>
            ) : null}
            {!isFile && (
                <SegmentedControl
                    value={mode}
                    onChange={(m) => {
                        if (m === mode) return;
                        onChange(m === 'field'
                            ? { kind: 'field', name: fieldNames[0] || '' }
                            : { kind: 'static', value: '' });
                    }}
                    options={mappingModes}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.mapping.source_aria', '{param} source', { param })}
                />
            )}
            {mode === 'field' ? (
                fieldNames.length ? (
                    <select
                        className={INPUT_CLS}
                        value={mapping?.name || ''}
                        onChange={(e) => onChange({ kind: 'field', name: e.target.value })}
                        disabled={disabled}
                        aria-label={t('studio_apps_insp.mapping.form_field_aria', '{param} form field', { param })}
                    >
                        <option value="">{t('studio_apps_insp.mapping.pick_field', 'Pick a field…')}</option>
                        {fieldNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                ) : isFile ? (
                    <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_insp.mapping.add_file_input', 'Add a File upload input to this form to feed this parameter.')}</p>
                ) : (
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={mapping?.name || ''}
                        onChange={(e) => onChange({ kind: 'field', name: e.target.value })}
                        placeholder={t('studio_apps_insp.mapping.field_name_placeholder', 'Field name (no enclosing form found)')}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={t('studio_apps_insp.mapping.form_field_name_aria', '{param} form field name', { param })}
                    />
                )
            ) : (
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={mapping?.value ?? ''}
                    onChange={(e) => onChange({ kind: 'static', value: e.target.value })}
                    placeholder={paramMeta?.type === 'array' || paramMeta?.type === 'object' ? t('studio_apps_insp.mapping.json_placeholder', 'JSON value, e.g. [] / {}') : t('studio_apps_insp.mapping.value_placeholder', 'Value')}
                    disabled={disabled}
                    aria-label={t('studio_apps_insp.mapping.static_value_aria', '{param} static value', { param })}
                />
            )}
            {isFile && selectedField?.multiple ? (
                <p className="text-xs text-amber-600">{t('studio_apps_insp.mapping.single_file', 'This automation expects a single file — a multi-file input sends only the first.')}</p>
            ) : null}
        </div>
    );
}
