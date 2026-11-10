import { useMemo } from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import { INPUT_CLS } from './panels/kit';
import { fieldsForTable } from '../bi/useAppTables';
import { autoMapping, extractableColumns, isUntouchedSchema, schemaFromColumns, writableColumns } from './aiFieldMatching';
import UpsertKeyPicker from './UpsertKeyPicker';
import ReplaceWhereField from './ReplaceWhereField';
import type { WriteTo, NamedField, MappingRowsProps, MappingSummaryProps, WriteToEditorProps } from './AiActionEditors.types';

/**
 * The write-to-table target of ai_extract, and (with `fixedOutputs`) of the steps whose outputs
 * are fixed names instead of an authored schema: file_intake and dataset_query. Moved out of
 * AiActionEditors so the sequence step editor (flow/StepSettings/fieldTypes/aiWriteTo) draws the
 * same control the bare action does.
 */

/** One "output field → column" row per declared field. */
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
                        {targets.map((col) => <option key={col.key} value={col.key}>{col.name || col.key}</option>)}
                    </select>
                </div>
            ))}
        </div>
    );
}

/** What the current mapping will actually save — an unmapped step saves nothing. */
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

/**
 * The writeTo after a table pick. The same table keeps everything; another table keeps only the
 * table-independent switches (the key, the constants and replaceWhere name columns of the old one).
 */
function retarget(writeTo: WriteTo | undefined, tableId: string): Omit<WriteTo, 'mapping'> {
    if (writeTo && writeTo.tableId === tableId) return writeTo;
    return {
        tableId,
        ...(writeTo?.insertMissing === false ? { insertMissing: false } : {}),
        ...(writeTo?.fillOnly === true ? { fillOnly: true } : {}),
    };
}

/** writeTo without replaceWhere, or with the new clause list. */
function withReplaceWhere(writeTo: WriteTo, next: unknown[] | undefined): WriteTo {
    const { replaceWhere: _old, ...rest } = writeTo;
    return next ? { ...rest, replaceWhere: next } : rest;
}

interface WriteToState {
    columns: ReturnType<typeof fieldsForTable>;
    fields: NamedField[];
    chooseTable: (tableId: string) => void;
    rematch: () => void;
    adoptColumns: () => void;
    setUpsertKey: (next: string[] | undefined) => void;
    columnForField: (fieldName: string) => string;
    setFieldColumn: (fieldName: string, col: string) => void;
}

/** The edits the editor offers over one writeTo. Every edit spreads the old object, so the fields it does not show survive. */
function useWriteToState({ writeTo, schemaFields, tables, onApply, fixedOutputs = false }: WriteToEditorProps): WriteToState {
    const columns = fieldsForTable(tables, writeTo?.tableId);
    const fields = useMemo(() => (Array.isArray(schemaFields) ? schemaFields : []).filter((f): f is NamedField => !!f.name), [schemaFields]);
    /**
     * Picking the table IS the configuration. An untouched schema is replaced by
     * the table's own columns (their names, types and select options), and every
     * field is matched to its column — so the common case needs no mapping work
     * at all. A schema the builder actually wrote is left alone and only matched.
     * Fixed outputs are never replaced: they are what the step produces.
     */
    const chooseTable = (tableId: string) => {
        if (!tableId) { onApply({ writeTo: undefined }); return; }
        const cols = fieldsForTable(tables, tableId);
        const derived = !fixedOutputs && isUntouchedSchema(fields) ? schemaFromColumns(cols) : [];
        const schema = derived.length ? derived : fields;
        onApply({
            ...(derived.length ? { schema: derived } : {}),
            writeTo: { ...retarget(writeTo, tableId), mapping: autoMapping(schema, cols) },
        });
    };
    const rematch = () => {
        if (writeTo) onApply({ writeTo: { ...writeTo, mapping: autoMapping(fields, columns) } });
    };
    const adoptColumns = () => {
        const derived = schemaFromColumns(columns);
        if (derived.length && writeTo) onApply({ schema: derived, writeTo: { ...writeTo, mapping: autoMapping(derived, columns) } });
    };
    const setUpsertKey = (next: string[] | undefined) => {
        if (!writeTo) return;
        const { upsertKey: _old, upsertOn, ...rest } = writeTo;
        // upsertOn is the older one-column form: a key that holds it replaces it.
        const keepOn = upsertOn && !(next || []).includes(upsertOn) ? { upsertOn } : {};
        onApply({ writeTo: { ...rest, ...keepOn, ...(next ? { upsertKey: next } : {}) } });
    };
    // mapping is { [columnKey]: schemaFieldName }; the UI is one row per output
    // field → target column, so we invert on write.
    const mapping = writeTo?.mapping || {};
    const columnForField = (fieldName: string) => Object.keys(mapping).find((col) => mapping[col] === fieldName) || '';
    const setFieldColumn = (fieldName: string, col: string) => {
        if (!writeTo) return;
        const next = { ...mapping };
        for (const key of Object.keys(next)) if (next[key] === fieldName) delete next[key];
        if (col) next[col] = fieldName;
        onApply({ writeTo: { ...writeTo, mapping: next } });
    };
    return { columns, fields, chooseTable, rematch, adoptColumns, setUpsertKey, columnForField, setFieldColumn };
}

type WriteToBodyProps = WriteToEditorProps & { writeTo: WriteTo; state: WriteToState };

/** Everything under the switch once a table is picked. */
function WriteToBody({ writeTo, tables, onApply, disabled, fixedOutputs = false, definition = null, node = null, state }: WriteToBodyProps) {
    const { t } = useTranslation();
    const { columns, fields, columnForField } = state;
    const targets = writableColumns(columns);
    const written = (key: string) => Object.hasOwn(writeTo.mapping || {}, key) || Object.hasOwn(writeTo.constants || {}, key);
    const writtenColumns = targets.filter((col) => written(col.key));
    const mapped = fields.filter((f) => columnForField(f.name)).length;
    return (
        <>
            <select
                className={INPUT_CLS}
                value={writeTo.tableId}
                onChange={(e) => state.chooseTable(e.target.value)}
                disabled={disabled}
                aria-label={t('studio_apps_insp.ai_actions.target_table', 'Target table')}
            >
                {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name || tb.key}</option>)}
            </select>
            <MappingRows fields={fields} targets={targets} columnForField={columnForField} onPick={state.setFieldColumn} disabled={disabled} />
            <MappingSummary mapped={mapped} total={fields.length} />
            <UpsertKeyPicker columns={writtenColumns} value={writeTo.upsertKey} onChange={state.setUpsertKey} disabled={disabled} />
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={state.rematch} disabled={disabled || !fields.length} className={MATCH_BTN_CLS}>
                    {t('studio_apps_insp.ai_actions.match_columns', 'Match to columns')}
                </button>
                {fixedOutputs ? null : (
                    <button
                        type="button"
                        onClick={state.adoptColumns}
                        disabled={disabled || extractableColumns(columns).length === 0}
                        className={MATCH_BTN_CLS}
                        title={t('studio_apps_insp.ai_actions.adopt_columns_title', 'Replace the fields above with one per column of this table')}
                    >
                        {t('studio_apps_insp.ai_actions.adopt_columns', "Use this table's columns")}
                    </button>
                )}
            </div>
            <ReplaceWhereField
                value={writeTo.replaceWhere}
                fields={columns}
                onChange={(next) => onApply({ writeTo: withReplaceWhere(writeTo, next) })}
                definition={definition}
                node={node}
                disabled={disabled}
            />
        </>
    );
}

export default function WriteToEditor(props: WriteToEditorProps) {
    const { t } = useTranslation();
    const { writeTo, tables, disabled, hint } = props;
    const state = useWriteToState(props);
    return (
        <FormField label={t('studio_apps_insp.ai_actions.save_to_table', 'Save results to a table')} hint={hint || t('studio_apps_insp.ai_actions.save_to_table_hint', 'Insert one row per extracted record.')}>
            <div className="flex flex-col gap-2">
                <Toggle
                    label={t('studio_apps_insp.ai_actions.write_rows', 'Write extracted rows to a data table')}
                    checked={!!writeTo?.tableId}
                    onChange={(v) => state.chooseTable(v ? (tables[0]?.id || '') : '')}
                    disabled={disabled || !tables.length}
                    size="sm"
                />
                {!tables.length ? (
                    <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_insp.ai_actions.no_tables', 'This app has no data tables yet.')}</p>
                ) : writeTo?.tableId ? <WriteToBody {...props} writeTo={writeTo} state={state} /> : null}
            </div>
        </FormField>
    );
}
