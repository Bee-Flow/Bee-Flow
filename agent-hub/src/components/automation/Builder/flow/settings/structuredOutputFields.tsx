// The AI step's "Structured output" rows, moved out of aiStepEditors.jsx
// unchanged (that file re-exports it: Skills Studio's OutputFieldsCard reads it
// from there).
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { cardClass, rowInputClass, subLabelClass } from './formPrimitives';
import { OUTPUT_FIELD_TYPES, COLUMN_TYPES } from './formState';
import { useTranslation } from '../../../../../hooks/useTranslation';

export interface ColumnRow { key: string; type: string }
export interface OutputFieldRow { key: string; type: string; description?: string; columns?: ColumnRow[] }

export function StructuredOutputFields({ fields, onChange }: { fields: OutputFieldRow[]; onChange: (next: OutputFieldRow[]) => void }) {
    const { t } = useTranslation();
    const update = (i: number, partial: Partial<OutputFieldRow>) => {
        const next = fields.slice();
        next[i] = { ...next[i], ...partial };
        onChange(next);
    };
    const remove = (i: number) => {
        const next = fields.slice();
        next.splice(i, 1);
        onChange(next);
    };
    const add = () => {
        const baseName = 'field';
        const taken = new Set(fields.map(f => f.key));
        let name = baseName, i = 1;
        while (taken.has(name)) name = `${baseName}${++i}`;
        onChange([...fields, { key: name, type: 'string', description: '' }]);
    };

    return (
        <div className="space-y-2">
            {fields.length === 0 && (
                <div className="text-[11px] text-[var(--text-tertiary)] italic">
                    {t('automations.structured_output_fields.no_fields_yet_the_ai_will', 'No fields yet — the AI will return free-form text. Add fields to get a structured JSON response.')}
                </div>
            )}
            {fields.map((f, i) => (
                <div key={i} className={cardClass()}>
                    <div className="flex items-center gap-1.5">
                        <input
                            type="text"
                            value={f.key || ''}
                            onChange={(e) => update(i, { key: e.target.value })}
                            placeholder={t('automations.structured_output_fields.field_name', 'fieldName')}
                            className={rowInputClass('flex-1 min-w-0 font-mono')}
                        />
                        <select
                            value={f.type || 'string'}
                            onChange={(e) => update(i, { type: e.target.value })}
                            className={rowInputClass('px-1.5')}
                        >
                            {OUTPUT_FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                        <button
                            type="button"
                            onClick={() => remove(i)}
                            className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10"
                            title={t('automations.structured_output_fields.remove_field', 'Remove field')}
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                    <input
                        type="text"
                        value={f.description || ''}
                        onChange={(e) => update(i, { description: e.target.value })}
                        placeholder={t('automations.structured_output_fields.description_optional_guides_the_model_on', 'Description (optional) — guides the model on what to put here')}
                        className={rowInputClass('w-full')}
                    />
                    {f.type === 'array' && (
                        <ColumnsEditor
                            columns={f.columns || []}
                            onChange={(next) => update(i, { columns: next })}
                        />
                    )}
                </div>
            ))}
            <button
                type="button"
                onClick={add}
                className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
            >
                <Plus size={12} /> {t('automations.structured_output_fields.add_output_field', 'Add output field')}
            </button>
        </div>
    );
}

// Column editor for a table (array-of-objects) output field. Each column is a
// { key, type } pair; together they become the array item's typed properties,
// so the model returns rows the Output panel renders as a real table. With no
// columns the array stays free-form (the model infers the shape).
function ColumnsEditor({ columns, onChange }: { columns: ColumnRow[]; onChange: (next: ColumnRow[]) => void }) {
    const { t } = useTranslation();
    const update = (i: number, partial: Partial<ColumnRow>) => {
        const next = columns.slice();
        next[i] = { ...next[i], ...partial };
        onChange(next);
    };
    const remove = (i: number) => {
        const next = columns.slice();
        next.splice(i, 1);
        onChange(next);
    };
    const add = () => {
        const taken = new Set(columns.map(c => c.key));
        let name = 'column', i = 1;
        while (taken.has(name)) name = `column${++i}`;
        onChange([...columns, { key: name, type: 'string' }]);
    };
    // Reorder a column — the schema (and therefore the output table) follows
    // this order, so up/down lets the user arrange the headers.
    const move = (i: number, dir: number) => {
        const j = i + dir;
        if (j < 0 || j >= columns.length) return;
        const next = columns.slice();
        [next[i], next[j]] = [next[j], next[i]];
        onChange(next);
    };

    return (
        <div className="mt-1 rounded border border-dashed border-[var(--border-default)] p-2 space-y-1.5">
            <div className={subLabelClass()}>
                {t('automations.structured_output_fields.columns', 'Columns')}
            </div>
            {columns.length === 0 && (
                <div className="text-[11px] text-[var(--text-tertiary)] italic">
                    {t('automations.structured_output_fields.no_columns_the_ai_infers_the', 'No columns — the AI infers the table shape. Add columns to fix the headers, their types, and order.')}
                </div>
            )}
            {columns.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5">
                    <div className="flex flex-col -my-0.5">
                        <button
                            type="button"
                            onClick={() => move(i, -1)}
                            disabled={i === 0}
                            className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed"
                            title={t('automations.structured_output_fields.move_up', 'Move up')}
                            aria-label={t('automations.structured_output_fields.move_column_up', 'Move column up')}
                        >
                            <ChevronUp size={11} />
                        </button>
                        <button
                            type="button"
                            onClick={() => move(i, 1)}
                            disabled={i === columns.length - 1}
                            className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed"
                            title={t('automations.structured_output_fields.move_down', 'Move down')}
                            aria-label={t('automations.structured_output_fields.move_column_down', 'Move column down')}
                        >
                            <ChevronDown size={11} />
                        </button>
                    </div>
                    <input
                        type="text"
                        value={c.key || ''}
                        onChange={(e) => update(i, { key: e.target.value })}
                        placeholder={t('automations.structured_output_fields.column_name', 'columnName')}
                        className={rowInputClass('flex-1 min-w-0 font-mono')}
                    />
                    <select
                        value={c.type || 'string'}
                        onChange={(e) => update(i, { type: e.target.value })}
                        className={rowInputClass('px-1.5')}
                    >
                        {COLUMN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button
                        type="button"
                        onClick={() => remove(i)}
                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10"
                        title={t('automations.structured_output_fields.remove_column', 'Remove column')}
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={add}
                className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
            >
                <Plus size={12} /> {t('automations.structured_output_fields.add_column', 'Add column')}
            </button>
        </div>
    );
}

