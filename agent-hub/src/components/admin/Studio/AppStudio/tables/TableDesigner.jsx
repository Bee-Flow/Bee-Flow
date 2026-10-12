import { AlertTriangle } from 'lucide-react';
import React, { useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { RepeatableList } from '../../../product-website/fields';
import FormulaField from '../inspector/logic/FormulaField';
import { NumberField, TextField } from '../inspector/panels/kit';

/**
 * App Studio — the field editor for ONE data-model table.
 *
 * Edits the table's display name and its fields (key/name/type + per-type
 * options: required, unique, default, a relation target, or a computed
 * expression). Pure controlled component: every change bubbles the next table
 * object through onChange; the parent (TablesManager) owns the model + Save.
 *
 * Field keys follow the server grammar (KEY_RE: a lowercase letter then
 * letters/digits/underscore) — a key is a real SQLite column name, so it is
 * slugified as the user types and never collides with a system column.
 *
 * Once a field EXISTS server-side its key is frozen: every screen, formula and
 * saved view that already reads the field addresses it by key, and renaming it
 * migrates the column out from under them. `savedTable` (the live table as the
 * server knows it) marks which fields that applies to; renaming stays possible
 * behind an explicit, warned opt-in.
 */

const fieldTypes = (t) => [
    { value: 'text', label: t('studio_apps_tables.designer.type_text', 'Text') },
    { value: 'richtext', label: t('studio_apps_tables.designer.type_richtext', 'Rich text') },
    { value: 'number', label: t('studio_apps_tables.designer.type_number', 'Number') },
    { value: 'date', label: t('studio_apps_tables.designer.type_date', 'Date') },
    { value: 'datetime', label: t('studio_apps_tables.designer.type_datetime', 'Date & time') },
    { value: 'bool', label: t('studio_apps_tables.designer.type_bool', 'Yes / no') },
    { value: 'select', label: t('studio_apps_tables.designer.type_select', 'Select') },
    { value: 'multiselect', label: t('studio_apps_tables.designer.type_multiselect', 'Multi-select') },
    { value: 'relation', label: t('studio_apps_tables.designer.type_relation', 'Relation') },
    { value: 'file', label: t('studio_apps_tables.designer.type_file', 'File') },
    { value: 'computed', label: t('studio_apps_tables.designer.type_computed', 'Computed') },
];

const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'created_by', 'org_id']);

function randHex(n) {
    let s = '';
    while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, n);
}
export function newFieldId() { return `fld_${randHex(6)}`; }

/** Slugify free text into a valid, non-system field key (letters/digits/_). */
export function slugifyKey(input) {
    let k = String(input || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!k) k = `field_${randHex(4)}`;
    if (SYSTEM_COLUMNS.has(k)) k = `${k}_field`;
    return k.slice(0, 63);
}

const CHECK_CLS = 'accent-[var(--accent-primary)]';
const FIELD_CLS =
    'w-full px-3 py-2 rounded-md text-sm border bg-[var(--bg-tertiary)] ' +
    'border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] ' +
    'focus:border-[var(--accent-primary)] transition-colors disabled:opacity-50';

/** A choice as the user reads it — the server stores strings or { value, label }. */
function optionLabel(option) {
    if (option && typeof option === 'object') return String(option.label ?? option.value ?? '');
    return String(option ?? '');
}
function nextOption(option, text) {
    return (option && typeof option === 'object') ? { ...option, value: text, label: text } : text;
}

/** Switching to a choice type seeds a few blank choices to fill in. */
function typePatch(field, type) {
    const patch = { type };
    if ((type === 'select' || type === 'multiselect') && !Array.isArray(field.options)) patch.options = ['', '', ''];
    return patch;
}

function FieldEditor({ field, update, tables, currentTableId, saved, disabled }) {
    const { t } = useTranslation();
    const set = (patch) => update({ ...field, ...patch });
    // While a key is still auto-derived (blank or matches the name's slug), keep
    // deriving it from the name; once the user edits the key explicitly, leave it.
    // A saved field's key is frozen — its name is then just a label.
    const keyIsAuto = !saved && (!field.key || field.key === slugifyKey(field.name));
    const [renaming, setRenaming] = useState(false);

    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
                <TextField
                    label={t('studio_apps_tables.designer.name', 'Name')}
                    value={field.name}
                    onChange={(v) => set({ name: v, key: keyIsAuto ? slugifyKey(v) : field.key })}
                    placeholder={t('studio_apps_tables.designer.name_placeholder', 'Amount')}
                    disabled={disabled}
                />
                {saved && !renaming ? (
                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_tables.designer.column_name', 'Column name')}</span>
                        <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-md px-3 py-2 text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{field.key}</code>
                            <button
                                type="button"
                                onClick={() => setRenaming(true)}
                                disabled={disabled}
                                className="shrink-0 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                            >
                                {t('studio_apps_tables.designer.change', 'Change…')}
                            </button>
                        </div>
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('studio_apps_tables.designer.fixed', 'Fixed — the app already refers to this field by this name.')}</span>
                    </div>
                ) : (
                    <TextField
                        label={t('studio_apps_tables.designer.column_name', 'Column name')}
                        value={field.key}
                        onChange={(v) => set({ key: slugifyKey(v) })}
                        hint={saved ? undefined : t('studio_apps_tables.designer.column_hint', 'Used inside the app')}
                        placeholder={t('studio_apps_tables.designer.column_placeholder', 'amount')}
                        disabled={disabled}
                    />
                )}
            </div>

            {saved && renaming ? (
                <p
                    className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                    style={{ borderColor: 'rgba(217, 119, 6, 0.4)', background: 'rgba(217, 119, 6, 0.1)', color: '#d97706' }}
                >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                        {t('studio_apps_tables.designer.rename_warning', 'Changing this stops every form, list and chart that already uses this field from finding it — you will have to point each of them at the new name yourself.')}
                    </span>
                </p>
            ) : null}

            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-secondary)]">
                {t('studio_apps_tables.designer.type', 'Type')}
                <select
                    className={FIELD_CLS}
                    value={field.type || 'text'}
                    onChange={(e) => set(typePatch(field, e.target.value))}
                    disabled={disabled}
                    aria-label={t('studio_apps_tables.designer.field_type', 'Field type')}
                >
                    {fieldTypes(t).map((ft) => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                </select>
            </label>

            {field.type === 'select' || field.type === 'multiselect' ? (
                <RepeatableList
                    items={Array.isArray(field.options) ? field.options : []}
                    onChange={(next) => set({ options: next })}
                    makeNew={() => ''}
                    label={t('studio_apps_tables.designer.choices', 'Choices')}
                    addLabel={t('studio_apps_tables.designer.add_choice', 'Add choice')}
                    itemLabel={(o) => optionLabel(o)}
                    renderItem={(option, updateOption, idx) => (
                        <input
                            className={FIELD_CLS}
                            value={optionLabel(option)}
                            onChange={(e) => updateOption(nextOption(option, e.target.value))}
                            placeholder={t('studio_apps_tables.designer.choice_placeholder', 'In progress')}
                            disabled={disabled}
                            aria-label={t('studio_apps_tables.designer.choice_n', 'Choice {n}', { n: idx + 1 })}
                            spellCheck={false}
                        />
                    )}
                />
            ) : null}

            <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)]">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" className={CHECK_CLS} checked={!!field.required} disabled={disabled}
                        onChange={(e) => set({ required: e.target.checked })} />
                    {t('studio_apps_tables.designer.required', 'Required')}
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" className={CHECK_CLS} checked={!!field.unique} disabled={disabled}
                        onChange={(e) => set({ unique: e.target.checked })} />
                    {t('studio_apps_tables.designer.unique', 'Unique')}
                </label>
            </div>

            {field.type === 'relation' ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-secondary)]">
                    {t('studio_apps_tables.designer.related_table', 'Related table')}
                    <select
                        className={FIELD_CLS}
                        value={field.relation?.table || ''}
                        onChange={(e) => set({ relation: { table: e.target.value } })}
                        disabled={disabled}
                        aria-label={t('studio_apps_tables.designer.related_table', 'Related table')}
                    >
                        <option value="">{t('studio_apps_tables.designer.choose_table', 'Choose a table…')}</option>
                        {(tables || []).filter((tb) => tb.id !== currentTableId).map((tb) => (
                            <option key={tb.id} value={tb.id}>{tb.name || tb.key}</option>
                        ))}
                    </select>
                </label>
            ) : field.type === 'computed' ? (
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_tables.designer.computed_expr', 'Computed expression')}</span>
                    <FormulaField
                        value={field.computed?.expr || ''}
                        onChange={(expr) => set({ computed: { ...(field.computed || {}), expr } })}
                        placeholder={t('studio_apps_tables.designer.computed_placeholder', 'e.g. price * quantity')}
                        disabled={disabled}
                    />
                </div>
            ) : field.type !== 'bool' && field.type !== 'file' ? (
                field.type === 'number' ? (
                    <NumberField
                        label={t('studio_apps_tables.designer.default', 'Default')}
                        value={field.default ?? null}
                        onChange={(v) => set({ default: v })}
                        disabled={disabled}
                    />
                ) : (
                    <TextField
                        label={t('studio_apps_tables.designer.default', 'Default')}
                        value={field.default ?? ''}
                        onChange={(v) => set({ default: v || null })}
                        disabled={disabled}
                    />
                )
            ) : null}
        </div>
    );
}

export default function TableDesigner({ table, tables, savedTable = null, onChange, disabled = false }) {
    const { t } = useTranslation();
    if (!table) return null;
    const set = (patch) => onChange({ ...table, ...patch });
    const fields = Array.isArray(table.fields) ? table.fields : [];
    const savedFieldIds = new Set((Array.isArray(savedTable?.fields) ? savedTable.fields : []).map((f) => f.id));

    return (
        <div className="flex flex-col gap-3">
            <TextField
                label={t('studio_apps_tables.designer.table_name', 'Table name')}
                value={table.name}
                onChange={(v) => set({ name: v })}
                hint={t('studio_apps_tables.designer.stored_as', 'Stored as: {key}', { key: table.key || '—' })}
                placeholder={t('studio_apps_tables.designer.table_placeholder', 'Invoices')}
                disabled={disabled}
            />

            <RepeatableList
                items={fields}
                onChange={(next) => set({ fields: next })}
                makeNew={() => ({ id: newFieldId(), key: '', name: '', type: 'text', required: false, unique: false })}
                label={t('studio_apps_tables.designer.fields', 'Fields')}
                addLabel={t('studio_apps_tables.designer.add_field', 'Add field')}
                collapsible
                itemLabel={(f) => f.name || f.key}
                renderItem={(field, update) => (
                    <FieldEditor
                        field={field}
                        update={update}
                        tables={tables}
                        currentTableId={table.id}
                        saved={savedFieldIds.has(field.id)}
                        disabled={disabled}
                    />
                )}
            />
        </div>
    );
}
