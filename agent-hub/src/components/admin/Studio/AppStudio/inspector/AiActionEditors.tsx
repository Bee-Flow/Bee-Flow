import useTranslation from '@/hooks/useTranslation';
import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { INPUT_CLS } from './panels/kit';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useAppTables, { fieldsForTable } from '../bi/useAppTables';
import { useEditorChrome } from '../editor/EditorChromeContext';
import { bindingForField, fieldNameFromBinding, type SchemaField } from './aiFieldMatching';
import { schemaEditPatch } from './aiSchemaEdits';
import type { AiAction, SchemaMeta, AiExtractEditorProps, KbQueryEditorProps, AiActionEditorProps } from './AiActionEditors.types';
import WriteToEditor from './WriteToEditor';
import { ModelTierRow, FieldSourcePicker, SchemaFieldsEditor, KbMultiSelect, ResultVarField, AiGenerateEditor } from './AiGenerateEditor';

/**
 * Inline editors for the native AI action kinds (ai_extract / ai_generate /
 * kb_query — server contract in server/appStudio/componentSpecs.js). Kept out of
 * ActionsSection so that file stays focused on event wiring; ActionsSection
 * renders <AiActionEditor/> for these kinds and passes the same `commit`.
 *
 * Reuse of existing pieces (per the plan): the shared <ModelTierSelector/> +
 * useModelTierSelection for the model tier, useAppTables for the write-to table
 * picker, GET /api/kb for the (owner-scoped, since only the owner edits)
 * knowledge-base grounding list. File/query sources are stored as a `formula`
 * binding `{kind:'formula', expr:'form.<field>'}` — the only binding kind that
 * both validates (BINDING_KINDS) and resolves a raw form value server-side.
 */

// ── Model tier ───────────────────────────────────────────────────────────────

// ── File / text source picker (formula binding over a form field) ────────────

// ── Output schema (declared fields) ──────────────────────────────────────────

// ── Knowledge-base grounding multiselect ─────────────────────────────────────

// ── Write-to-table target (ai_extract): WriteToEditor.tsx ───────────────────

// ── resultVar ────────────────────────────────────────────────────────────────

// ── Per-kind editors ─────────────────────────────────────────────────────────

function AiExtractEditor({ action, commit, formFields, disabled }: AiExtractEditorProps) {
    const { t } = useTranslation();
    const set = (patch: Partial<AiAction>) => commit({ ...action, ...patch });
    const chrome = useEditorChrome();
    const { tables } = useAppTables(chrome?.appId ?? null);
    const fileFields = useMemo(() => formFields.filter((f) => f.type === 'input_file'), [formFields]);
    const sourceName = fieldNameFromBinding(action.source);
    // `source` is required, so a step wired up before its form had a file input
    // sits there showing a red "missing required source". When the choice is
    // unambiguous, make it — ONCE. Clearing the field is a deliberate act; a
    // second seed would refill it before the user can pick anything else.
    const sourceSettled = useRef(false);
    const seedSource = useEffectEvent(() => set({ source: bindingForField(fileFields[0].name) }));
    useEffect(() => {
        if (sourceName) { sourceSettled.current = true; return; }
        if (disabled || sourceSettled.current || fileFields.length !== 1) return;
        sourceSettled.current = true;
        seedSource();
    }, [disabled, sourceName, fileFields]);
    /**
     * Schema edits keep the write-to mapping honest: a renamed field follows its
     * column (and adopts one if its new name now matches a free column), and a
     * removed field releases it. Without this the mapping points at a name that
     * no longer exists and the column silently writes null.
     */
    const setSchema = (schema: SchemaField[], meta?: SchemaMeta) => {
        set(schemaEditPatch(schema, meta, action.writeTo, fieldsForTable(tables, action.writeTo?.tableId)));
    };
    return (
        <>
            <FieldSourcePicker
                label={t('studio_apps_insp.ai_actions.document_input', 'Document input')}
                hint={t('studio_apps_insp.ai_actions.document_input_hint', 'A File upload input holding the document(s) to read.')}
                binding={action.source}
                formFields={fileFields}
                onChange={(b) => set({ source: b })}
                disabled={disabled}
                ariaLabel={t('studio_apps_insp.ai_actions.document_input_aria', 'Document input field')}
            />
            <SchemaFieldsEditor
                fields={action.schema}
                onChange={setSchema}
                disabled={disabled}
                hint={action.writeTo?.tableId ? t('studio_apps_insp.ai_actions.fields_hint_table', 'The AI returns these; matching columns are filled in below.') : t('studio_apps_insp.ai_actions.fields_hint', 'The typed fields the AI should output.')}
            />
            <ModelTierRow value={action.modelTier} onChange={(tier) => set({ modelTier: tier })} disabled={disabled} />
            <KbMultiSelect value={action.knowledgeBaseIds} onChange={(ids) => set({ knowledgeBaseIds: ids })} disabled={disabled} />
            <WriteToEditor
                writeTo={action.writeTo}
                schemaFields={action.schema}
                tables={tables}
                onApply={({ writeTo, ...rest }) => {
                    const next = { ...action, ...rest };
                    if (writeTo) next.writeTo = writeTo; else delete next.writeTo;
                    commit(next);
                }}
                disabled={disabled}
            />
            <ResultVarField value={action.resultVar} onChange={(v) => set({ resultVar: v })} disabled={disabled} />
        </>
    );
}

function KbQueryEditor({ action, commit, formFields, disabled }: KbQueryEditorProps) {
    const { t } = useTranslation();
    const set = (patch: Partial<AiAction>) => commit({ ...action, ...patch });
    const q = action.query || null;
    const mode = q?.kind === 'static' ? 'static' : 'field';
    return (
        <>
            <FormField label={t('studio_apps_insp.ai_actions.question', 'Question')}>
                <SegmentedControl
                    value={mode}
                    onChange={(m) => set({ query: m === 'field' ? bindingForField(formFields[0]?.name || '') : { kind: 'static', value: '' } })}
                    options={[{ value: 'field', label: t('studio_apps_insp.ai_actions.form_field', 'Form field') }, { value: 'static', label: t('studio_apps_insp.ai_actions.static', 'Static') }]}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.ai_actions.query_source', 'Query source')}
                />
            </FormField>
            {mode === 'field' ? (
                <FieldSourcePicker
                    label={t('studio_apps_insp.ai_actions.from_input', 'From input')}
                    binding={q}
                    formFields={formFields}
                    onChange={(b) => set({ query: b || { kind: 'static', value: '' } })}
                    disabled={disabled}
                    ariaLabel={t('studio_apps_insp.ai_actions.query_field', 'Query field')}
                />
            ) : (
                <FormField label={t('studio_apps_insp.ai_actions.text', 'Text')}>
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={q?.value || ''}
                        onChange={(e) => set({ query: { kind: 'static', value: e.target.value } })}
                        placeholder={t('studio_apps_insp.ai_actions.query_placeholder', 'What is the refund policy?')}
                        disabled={disabled}
                        aria-label={t('studio_apps_insp.ai_actions.query_text', 'Query text')}
                    />
                </FormField>
            )}
            <KbMultiSelect value={action.knowledgeBaseIds} onChange={(ids) => set({ knowledgeBaseIds: ids })} disabled={disabled} />
            <FormField label={t('studio_apps_insp.ai_actions.max_results', 'Max results')}>
                <input
                    type="number"
                    min={1}
                    max={20}
                    className={INPUT_CLS}
                    value={action.topK ?? 6}
                    onChange={(e) => { const n = parseInt(e.target.value, 10); set({ topK: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 6 }); }}
                    disabled={disabled}
                    aria-label={t('studio_apps_insp.ai_actions.max_results', 'Max results')}
                />
            </FormField>
            <ResultVarField value={action.resultVar} onChange={(v) => set({ resultVar: v })} disabled={disabled} required />
        </>
    );
}

export default function AiActionEditor({ action, commit, formFields, disabled }: AiActionEditorProps) {
    if (action.kind === 'ai_extract') return <AiExtractEditor action={action} commit={commit} formFields={formFields} disabled={disabled} />;
    if (action.kind === 'ai_generate') return <AiGenerateEditor action={action} commit={commit} formFields={formFields} disabled={disabled} />;
    if (action.kind === 'kb_query') return <KbQueryEditor action={action} commit={commit} formFields={formFields} disabled={disabled} />;
    return null;
}
