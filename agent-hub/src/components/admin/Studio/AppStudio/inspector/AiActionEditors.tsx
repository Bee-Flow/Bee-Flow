import useTranslation from '@/hooks/useTranslation';
import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { INPUT_CLS } from './panels/kit';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import Toggle from '@/components/shared/Toggle';
import useAppTables, { fieldsForTable } from '../bi/useAppTables';
import { useEditorChrome } from '../editor/EditorChromeContext';
import { autoMapping, bindingForField, extractableColumns, fieldNameFromBinding, isUntouchedSchema, schemaFromColumns, writableColumns, type FormulaBinding, type SchemaField, type TableColumn } from './aiFieldMatching';
import type { FormFieldRef, AppAction } from './appDefinition';
import type { AppTable } from '../bi/useAppTables';
import type { SourceBinding, WriteTo, NamedField, AiAction, SchemaMeta, ApplyPatch, MappingRowsProps, MappingSummaryProps, WriteToEditorProps, AiExtractEditorProps, KbQueryEditorProps, AiActionEditorProps } from './AiActionEditors.types';
import { ModelTierRow, FieldSourcePicker, SchemaFieldsEditor, KbMultiSelect, ResultVarField, AiGenerateEditor } from './AiGenerateEditor';
;

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

// ── Write-to-table target (ai_extract) ───────────────────────────────────────

function MappingRows({ fields, targets, columnForField, onPick, disabled }: MappingRowsProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1.5">
            {fields.map((f) => (
                <div key={f.name} className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[var(--text-tertiary)] w-24 truncate" title={f.name}>{f.name}</span>
                    <span className="text-[var(--text-tertiary)]">→</span>
                    <select
                        className={INPUT_CLS}
                        value={columnForField(f.name)}
                        onChange={(e) => onPick(f.name, e.target.value)}
                        disabled={disabled}
                        aria-label={t('studio_apps_insp.ai_actions.column_for', 'Column for {name}', { name: f.name })}
                    >
                        <option value="">{t('studio_apps_insp.ai_actions.dont_save', "(don't save)")}</option>
                        {targets.map((c) => <option key={c.key} value={c.key}>{c.name || c.key}</option>)}
                    </select>
                </div>
            ))}
        </div>
    );
}

function MappingSummary({ mapped, total }: MappingSummaryProps) {
    const { t } = useTranslation();
    if (!total) return null;
    let text: string;
    if (mapped === total) {
        text = mapped === 1
            ? t('studio_apps_insp.ai_actions.all_match_one', 'All {count} field matches a column.', { count: mapped })
            : t('studio_apps_insp.ai_actions.all_match_many', 'All {count} fields match a column.', { count: mapped });
    } else if (mapped) {
        text = t('studio_apps_insp.ai_actions.some_match', '{mapped} of {total} fields are saved — the rest are ignored.', { mapped, total });
    } else {
        text = t('studio_apps_insp.ai_actions.none_match', 'No field matches a column, so nothing would be saved.');
    }
    return <p className={`text-xs ${mapped ? 'text-[var(--text-tertiary)]' : 'text-amber-600'}`}>{text}</p>;
}

const MATCH_BTN_CLS = 'px-2.5 py-1 text-xs rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-50';

function WriteToEditor({ writeTo, schemaFields, tables, onApply, disabled }: WriteToEditorProps) {
    const { t } = useTranslation();
    const enabled = !!(writeTo && writeTo.tableId);
    const columns = fieldsForTable(tables, writeTo?.tableId);
    const targets = useMemo(() => writableColumns(columns), [columns]);
    const fields = useMemo(() => (Array.isArray(schemaFields) ? schemaFields : []).filter((f): f is NamedField => !!f.name), [schemaFields]);
    /**
     * Picking the table IS the configuration. An untouched schema is replaced by
     * the table's own columns (their names, types and select options), and every
     * field is matched to its column — so the common case needs no mapping work
     * at all. A schema the builder actually wrote is left alone and only matched.
     */
    const chooseTable = (tableId: string) => {
        if (!tableId) { onApply({ writeTo: undefined }); return; }
        const cols = fieldsForTable(tables, tableId);
        const derived = isUntouchedSchema(fields) ? schemaFromColumns(cols) : [];
        const schema = derived.length ? derived : fields;
        onApply({
            ...(derived.length ? { schema: derived } : {}),
            writeTo: { tableId, mapping: autoMapping(schema, cols) },
        });
    };
    const rematch = () => {
        if (!writeTo) return;
        onApply({ writeTo: { tableId: writeTo.tableId, mapping: autoMapping(fields, columns) } });
    };
    const adoptColumns = () => {
        const derived = schemaFromColumns(columns);
        if (!derived.length || !writeTo) return;
        onApply({ schema: derived, writeTo: { tableId: writeTo.tableId, mapping: autoMapping(derived, columns) } });
    };
    // mapping is { [columnKey]: schemaFieldName }; the UI is one row per output
    // field → target column, so we invert on write.
    const mapping = writeTo?.mapping || {};
    const columnForField = (fieldName: string) => Object.keys(mapping).find((col) => mapping[col] === fieldName) || '';
    const setFieldColumn = (fieldName: string, col: string) => {
        if (!writeTo) return;
        const next = { ...mapping };
        for (const c of Object.keys(next)) if (next[c] === fieldName) delete next[c];
        if (col) next[col] = fieldName;
        onApply({ writeTo: { tableId: writeTo.tableId, mapping: next } });
    };
    const mapped = fields.filter((f) => columnForField(f.name)).length;
    const canAdopt = enabled && extractableColumns(columns).length > 0;
    return (
        <FormField label={t('studio_apps_insp.ai_actions.save_to_table', 'Save results to a table')} hint={t('studio_apps_insp.ai_actions.save_to_table_hint', 'Insert one row per extracted record.')}>
            <div className="flex flex-col gap-2">
                <Toggle
                    label={t('studio_apps_insp.ai_actions.write_rows', 'Write extracted rows to a data table')}
                    checked={enabled}
                    onChange={(v) => chooseTable(v ? (tables[0]?.id || '') : '')}
                    disabled={disabled || !tables.length}
                    size="sm"
                />
                {!tables.length ? (
                    <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_insp.ai_actions.no_tables', 'This app has no data tables yet.')}</p>
                ) : enabled ? (
                    <>
                        <select
                            className={INPUT_CLS}
                            value={writeTo?.tableId}
                            onChange={(e) => chooseTable(e.target.value)}
                            disabled={disabled}
                            aria-label={t('studio_apps_insp.ai_actions.target_table', 'Target table')}
                        >
                            {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name || tb.key}</option>)}
                        </select>
                        <MappingRows
                            fields={fields}
                            targets={targets}
                            columnForField={columnForField}
                            onPick={setFieldColumn}
                            disabled={disabled}
                        />
                        <MappingSummary mapped={mapped} total={fields.length} />
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={rematch}
                                disabled={disabled || !fields.length}
                                className={MATCH_BTN_CLS}
                            >
                                {t('studio_apps_insp.ai_actions.match_columns', 'Match to columns')}
                            </button>
                            <button
                                type="button"
                                onClick={adoptColumns}
                                disabled={disabled || !canAdopt}
                                className={MATCH_BTN_CLS}
                                title={t('studio_apps_insp.ai_actions.adopt_columns_title', 'Replace the fields above with one per column of this table')}
                            >
                                {t('studio_apps_insp.ai_actions.adopt_columns', "Use this table's columns")}
                            </button>
                        </div>
                    </>
                ) : null}
            </div>
        </FormField>
    );
}

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
        const patch: { schema: SchemaField[]; writeTo?: WriteTo } = { schema };
        const w = action.writeTo;
        if (w?.tableId && meta) {
            const columns = fieldsForTable(tables, w.tableId);
            const next: Record<string, string> = {};
            for (const [col, fieldName] of Object.entries(w.mapping || {})) {
                if (meta.removed && fieldName === meta.removed) continue;
                next[col] = meta.renamed && fieldName === meta.renamed.from ? meta.renamed.to : fieldName;
            }
            // A rename onto a still-free column is an explicit "put it here".
            if (meta.renamed && !Object.values(next).includes(meta.renamed.to)) {
                const hit = autoMapping([{ name: meta.renamed.to }], columns.filter((c) => !(c.key in next)));
                Object.assign(next, hit);
            }
            patch.writeTo = { tableId: w.tableId, mapping: next };
        }
        set(patch);
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
