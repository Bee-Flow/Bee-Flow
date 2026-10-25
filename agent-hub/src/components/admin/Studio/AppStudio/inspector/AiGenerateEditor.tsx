import { X } from 'lucide-react';
import useTranslation from '../../../../../hooks/useTranslation';
import { useEffect, useMemo, useState } from 'react';
import { INPUT_CLS } from './panels/kit';
import ExpressionInput from './logic/ExpressionInput';
import FormField from '../../../../shared/FormField';
import SegmentedControl from '../../../../shared/SegmentedControl';
import Toggle from '../../../../shared/Toggle';
import IconButton from '../../../../shared/IconButton';
import ModelTierSelector from '../../../../licensing/ModelTierSelector';
import useModelTierSelection from '../../../../../hooks/useModelTierSelection';
import { useStudioKnowledgeBases } from '../../../../../api/queries/studioApps';
import { bindingForField, fieldNameFromBinding, sanitizeVarName, type SchemaField } from './aiFieldMatching';
import type { TranslateParams } from '../../../../../hooks/useTranslation';
import type { AiAction, KnowledgeBase, SchemaMeta, ModelTierRowProps, FieldSourcePickerProps, SchemaFieldsEditorProps, KbMultiSelectProps, ResultVarFieldProps, AiGenerateEditorProps } from './AiActionEditors.types';

const schemaTypeOptions = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: 'string', label: t('studio_apps_insp.ai_actions.type_text', 'Text') },
    { value: 'number', label: t('studio_apps_insp.ai_actions.type_number', 'Number') },
    { value: 'boolean', label: t('studio_apps_insp.ai_actions.type_boolean', 'Yes / No') },
    { value: 'date', label: t('studio_apps_insp.ai_actions.type_date', 'Date') },
    { value: 'array', label: t('studio_apps_insp.ai_actions.type_list', 'List') },
    { value: 'object', label: t('studio_apps_insp.ai_actions.type_object', 'Object') },
];

export function ModelTierRow({ value, onChange, disabled }: ModelTierRowProps) {
    const { t } = useTranslation();
    const { modelTiers } = useModelTierSelection({ storageKey: 'appStudioAiTier', taskType: 'direct_chat' });
    return (
        <FormField label={t('studio_apps_insp.ai_actions.model', 'Model')} hint={t('studio_apps_insp.ai_actions.model_hint', "Runs on the app owner's model tier.")}>
            {/* portal: the inspector scrolls, so an absolute panel gets clipped. */}
            <div className={disabled ? 'pointer-events-none opacity-50' : ''}>
                <ModelTierSelector tiers={modelTiers} value={value || 'auto'} onChange={onChange} dropDirection="down" portal />
            </div>
        </FormField>
    );
}

export function FieldSourcePicker({ label, hint, binding, formFields, onChange, disabled, ariaLabel }: FieldSourcePickerProps) {
    const { t } = useTranslation();
    const current = fieldNameFromBinding(binding);
    const rawExpr = (binding && binding.kind === 'formula' && typeof binding.expr === 'string') ? binding.expr : '';
    // An expression that is not `form.<field>` can only be edited as text — and
    // it is the ONLY way to reach a document that did not come from a form
    // input, e.g. `item.file` inside a loop over a table of attachments. The
    // picker used to hardcode form fields, which made "extract the invoice
    // attached to this ticket" unauthorable.
    const [expert, setExpert] = useState(Boolean(rawExpr) && !current);
    return (
        <FormField label={label} hint={hint}>
            {expert ? (
                <div className="flex flex-col gap-1">
                    {/* No definition/node: the variable groups come from the
                        StudioScopeProvider around the Actions section, and a
                        document source is never a boolean, so the condition
                        builder has no business here. */}
                    <ExpressionInput
                        variant="inline"
                        value={rawExpr}
                        placeholder="item.file"
                        onChange={(expr) => onChange(expr ? { kind: 'formula', expr } : null)}
                        disabled={disabled}
                        ariaLabel={t('studio_apps_insp.ai_actions.expression_aria', '{label} expression', { label: ariaLabel })}
                    />
                    <button
                        type="button"
                        className="self-start text-[11px] text-[var(--text-tertiary)] underline"
                        onClick={() => { setExpert(false); onChange(null); }}
                        disabled={disabled}
                    >
                        {t('studio_apps_insp.ai_actions.pick_form_input', 'Pick a form input instead')}
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-1">
                    {formFields.length ? (
                        <select
                            className={INPUT_CLS}
                            value={current}
                            onChange={(e) => onChange(bindingForField(e.target.value))}
                            disabled={disabled}
                            aria-label={ariaLabel}
                        >
                            <option value="">{t('studio_apps_insp.ai_actions.pick_input', 'Pick an input…')}</option>
                            {formFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                        </select>
                    ) : (
                        <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_insp.ai_actions.add_input_hint', 'Add an input to the enclosing form to feed this.')}</p>
                    )}
                    <button
                        type="button"
                        className="self-start text-[11px] text-[var(--text-tertiary)] underline"
                        onClick={() => setExpert(true)}
                        disabled={disabled}
                    >
                        {t('studio_apps_insp.ai_actions.use_expression', 'Use an expression (e.g. a row from a list)')}
                    </button>
                </div>
            )}
        </FormField>
    );
}

export function SchemaFieldsEditor({ fields, onChange, disabled, hint }: SchemaFieldsEditorProps) {
    const { t } = useTranslation();
    const list = Array.isArray(fields) ? fields : [];
    // onChange(next, meta) — `meta.renamed` lets the caller carry a write-to
    // mapping across a rename instead of silently orphaning that column.
    const update = (i: number, patch: Partial<SchemaField>, meta?: SchemaMeta) => onChange(list.map((f, idx) => (idx === i ? { ...f, ...patch } : f)), meta);
    const rename = (i: number, next: string) => update(i, { name: next }, list[i]?.name && next ? { renamed: { from: list[i]?.name, to: next } } : undefined);
    const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i), { removed: list[i]?.name });
    const add = () => {
        const taken = new Set(list.map((f) => f.name));
        let name = 'field';
        let n = 1;
        while (taken.has(name)) name = `field${++n}`;
        onChange([...list, { name, type: 'string', description: '', required: false }]);
    };
    return (
        <FormField label={t('studio_apps_insp.ai_actions.fields_to_return', 'Fields to return')} hint={hint || t('studio_apps_insp.ai_actions.fields_hint', 'The typed fields the AI should output.')}>
            <div className="flex flex-col gap-2">
                {list.map((f, i) => (
                    <div key={i} className="rounded-md border border-[var(--border-subtle)] p-2.5 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                className={`${INPUT_CLS} font-mono text-xs`}
                                value={f.name || ''}
                                onChange={(e) => rename(i, sanitizeVarName(e.target.value))}
                                placeholder="field_name"
                                disabled={disabled}
                                spellCheck={false}
                                aria-label={t('studio_apps_insp.ai_actions.field_name_aria', 'Field {n} name', { n: i + 1 })}
                            />
                            <select
                                className={`${INPUT_CLS} max-w-[8rem]`}
                                value={f.type || 'string'}
                                onChange={(e) => update(i, { type: e.target.value })}
                                disabled={disabled}
                                aria-label={t('studio_apps_insp.ai_actions.field_type_aria', 'Field {n} type', { n: i + 1 })}
                            >
                                {schemaTypeOptions(t).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <IconButton ariaLabel={t('studio_apps_insp.ai_actions.remove_field', 'Remove field {name}', { name: f.name })} onClick={() => remove(i)} disabled={disabled} variant="danger" size="sm">
                                <X />
                            </IconButton>
                        </div>
                        <input
                            type="text"
                            className={INPUT_CLS}
                            value={f.description || ''}
                            onChange={(e) => update(i, { description: e.target.value })}
                            placeholder={t('studio_apps_insp.ai_actions.description_placeholder', 'Description (helps the AI, optional)')}
                            disabled={disabled}
                            aria-label={t('studio_apps_insp.ai_actions.field_description_aria', 'Field {n} description', { n: i + 1 })}
                        />
                        <Toggle
                            label={t('studio_apps_insp.ai_actions.required', 'Required')}
                            checked={!!f.required}
                            onChange={(v) => update(i, { required: v })}
                            disabled={disabled}
                            size="sm"
                        />
                    </div>
                ))}
                <button
                    type="button"
                    onClick={add}
                    disabled={disabled}
                    className="px-3 py-1.5 text-xs rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-50"
                >
                    {t('studio_apps_insp.ai_actions.add_field', '+ Add field')}
                </button>
            </div>
        </FormField>
    );
}

export function KbMultiSelect({ value, onChange, disabled }: KbMultiSelectProps) {
    const { t } = useTranslation();
    const kbs = useStudioKnowledgeBases<KnowledgeBase>(); // null = loading
    const selected = new Set(Array.isArray(value) ? value : []);
    const toggle = (id: string) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id); else next.add(id);
        onChange([...next]);
    };
    return (
        <FormField label={t('studio_apps_insp.ai_actions.knowledge_bases', 'Knowledge bases')} hint={t('studio_apps_insp.ai_actions.knowledge_bases_hint', 'Ground the AI in these (optional).')}>
            {kbs === null ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_insp.ai_actions.loading', 'Loading…')}</p>
            ) : kbs.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_insp.ai_actions.no_knowledge_bases', 'No knowledge bases yet.')}</p>
            ) : (
                <div className="flex flex-col gap-1.5 max-h-40 overflow-auto">
                    {kbs.map((kb) => (
                        <label key={kb.id} className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                            <input
                                type="checkbox"
                                checked={selected.has(kb.id)}
                                onChange={() => toggle(kb.id)}
                                disabled={disabled}
                                aria-label={t('studio_apps_insp.ai_actions.ground_in', 'Ground in {name}', { name: kb.name || kb.id })}
                            />
                            <span className="truncate">{kb.name || kb.id}</span>
                        </label>
                    ))}
                </div>
            )}
        </FormField>
    );
}

export function ResultVarField({ value, onChange, disabled, required }: ResultVarFieldProps) {
    const { t } = useTranslation();
    return (
        <FormField label={t('studio_apps_insp.ai_actions.store_result_as', 'Store result as')} hint={required ? t('studio_apps_insp.ai_actions.result_hint_required', 'A variable name to reference the result in later steps.') : t('studio_apps_insp.ai_actions.result_hint_optional', 'Optional variable name for later steps.')}>
            <input
                type="text"
                className={`${INPUT_CLS} font-mono text-xs`}
                value={value || ''}
                onChange={(e) => onChange(sanitizeVarName(e.target.value))}
                placeholder={t('studio_apps_insp.ai_actions.result_placeholder', 'result')}
                disabled={disabled}
                spellCheck={false}
                aria-label={t('studio_apps_insp.ai_actions.result_variable_aria', 'Result variable name')}
            />
        </FormField>
    );
}

export function AiGenerateEditor({ action, commit, formFields, disabled }: AiGenerateEditorProps) {
    const { t } = useTranslation();
    const set = (patch: Partial<AiAction>) => commit({ ...action, ...patch });
    const fileFields = useMemo(() => formFields.filter((f) => f.type === 'input_file'), [formFields]);
    const output = action.output === 'structured' ? 'structured' : 'text';
    return (
        <>
            <FormField label={t('studio_apps_insp.ai_actions.prompt', 'Prompt')} hint={t('studio_apps_insp.ai_actions.prompt_hint', 'Use {{form.fieldName}} to insert form values.')}>
                <textarea
                    className={`${INPUT_CLS} min-h-[80px]`}
                    value={action.prompt || ''}
                    onChange={(e) => set({ prompt: e.target.value })}
                    placeholder={t('studio_apps_insp.ai_actions.prompt_placeholder', 'Summarize {{form.notes}} in three bullet points.')}
                    disabled={disabled}
                    aria-label={t('studio_apps_insp.ai_actions.prompt_aria', 'AI prompt')}
                />
            </FormField>
            <FormField label={t('studio_apps_insp.ai_actions.output', 'Output')}>
                <SegmentedControl
                    value={output}
                    onChange={(o) => set({ output: o })}
                    options={[{ value: 'text', label: t('studio_apps_insp.ai_actions.type_text', 'Text') }, { value: 'structured', label: t('studio_apps_insp.ai_actions.output_structured', 'Structured') }]}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.ai_actions.output_type', 'Output type')}
                />
            </FormField>
            {output === 'structured' && (
                <SchemaFieldsEditor fields={action.schema} onChange={(s) => set({ schema: s })} disabled={disabled} />
            )}
            {fileFields.length > 0 && (
                <FieldSourcePicker
                    label={t('studio_apps_insp.ai_actions.attach_document', 'Attach a document (optional)')}
                    binding={action.attachments}
                    formFields={fileFields}
                    onChange={(b) => set({ attachments: b || undefined })}
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.ai_actions.attachment_aria', 'Attachment field')}
                />
            )}
            <ModelTierRow value={action.modelTier} onChange={(tier) => set({ modelTier: tier })} disabled={disabled} />
            <KbMultiSelect value={action.knowledgeBaseIds} onChange={(ids) => set({ knowledgeBaseIds: ids })} disabled={disabled} />
            <ResultVarField value={action.resultVar} onChange={(v) => set({ resultVar: v })} disabled={disabled} required />
        </>
    );
}
