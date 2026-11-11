import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { expandAlias, expandEntries, pickableFields, pickedOf, relationLinks, toggleField, togglePick, MAX_EXPAND } from '@/components/admin/Studio/AppStudio/bi/relationRead';
import type { AppTable } from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import type { TableColumn } from '../../aiFieldMatching';
import type { BindingDraft } from '../BindingField.types';

interface RelatedFieldsProps {
    binding: BindingDraft;
    tables: AppTable[];
    fields: TableColumn[];
    onPatch: (patch: { expand?: BindingDraft['expand']; fields?: BindingDraft['fields'] }) => void;
    disabled?: boolean;
}

interface TickProps {
    label: string;
    checked: boolean;
    onToggle: () => void;
    disabled?: boolean;
}

function Tick({ label, checked, onToggle, disabled = false }: TickProps) {
    return (
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} className="accent-[var(--accent-primary)]" />
            {label}
        </label>
    );
}

/**
 * What a table binding reads beyond its own rows, behind one closed disclosure
 * (open when the binding already uses it), so a binding that needs neither
 * looks and saves exactly as before:
 *   - per linked table, which of its fields to bring along (`expand`); a column
 *     then shows them as `<relation>_record.<field>`;
 *   - which of the table's own columns to load (`fields`), all when none is ticked.
 */
export function RelatedFields({ binding, tables, fields, onPatch, disabled = false }: RelatedFieldsProps) {
    const { t } = useTranslation();
    const links = relationLinks(tables, binding.tableId);
    const entries = expandEntries(binding.expand);
    const loaded = Array.isArray(binding.fields) ? binding.fields : [];
    const full = entries.length >= MAX_EXPAND;
    // Open from the start when the binding already reads through a relation or names its columns.
    const [open, setOpen] = useState(entries.length > 0 || loaded.length > 0);
    return (
        <details className="rounded-md border border-[var(--border-default)] px-2 py-1.5" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">{t('studio_apps_expand.title', 'Linked records and columns')}</summary>
            <div className="mt-2 flex flex-col gap-3">
                {links.length === 0 ? (
                    <p className="text-[11px] text-[var(--text-muted)]">{t('studio_apps_expand.no_relations', 'This table has no field that links to another table of the app.')}</p>
                ) : links.map(({ field, target }) => {
                    const picked = pickedOf(entries, field.key);
                    const entry = entries.find((e) => e.field === field.key);
                    return (
                        <fieldset key={field.key} className="flex min-w-0 flex-col gap-1" disabled={disabled}>
                            <legend className="text-xs font-medium text-[var(--text-primary)]">
                                {t('studio_apps_expand.relation_legend', '{relation}: fields of {table}', { relation: field.name || field.key, table: target.name || target.key })}
                            </legend>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                                {pickableFields(target).map((f) => (
                                    <Tick
                                        key={f.key}
                                        label={f.name || f.key}
                                        checked={picked.includes(f.key)}
                                        disabled={disabled || (!entry && full)}
                                        onToggle={() => onPatch({ expand: togglePick(binding.expand, field.key, f.key) })}
                                    />
                                ))}
                            </div>
                            {entry ? (
                                <p className="text-[11px] text-[var(--text-muted)]">
                                    {t('studio_apps_expand.column_hint', 'Use them in a column as {example}.', { example: `${expandAlias(entry)}.${picked[0] ?? '…'}` })}
                                </p>
                            ) : null}
                        </fieldset>
                    );
                })}
                {links.length > 0 ? <p className="text-[11px] text-[var(--text-muted)]">{t('studio_apps_expand.access_hint', 'A linked record the viewer may not see stays empty.')}</p> : null}
                <fieldset className="flex min-w-0 flex-col gap-1" disabled={disabled}>
                    <legend className="text-xs font-medium text-[var(--text-primary)]">{t('studio_apps_expand.fields_legend', 'Columns to load')}</legend>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {fields.filter((f) => f.type !== 'computed').map((f) => (
                            <Tick key={f.key} label={f.name || f.key} checked={loaded.includes(f.key)} disabled={disabled} onToggle={() => onPatch({ fields: toggleField(binding.fields, f.key) })} />
                        ))}
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)]">{t('studio_apps_expand.fields_hint', 'Tick none to load every column.')}</p>
                </fieldset>
            </div>
        </details>
    );
}
