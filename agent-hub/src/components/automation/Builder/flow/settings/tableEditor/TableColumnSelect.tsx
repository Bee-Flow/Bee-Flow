import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import type { TableColumn } from '../../../../../../api/queries/automation/runTables';
import type { ColumnKind, DescribedColumn } from '../../../../../../api/queries/automation/tablePreview';
import { rowInputClass } from '../formStyles';
import type { Translate } from './opHelp';

/** What a picker suggests first. */
export type ColumnPreference = 'any' | 'split' | 'numeric' | 'personal';

type Described = ReadonlyMap<string, DescribedColumn>;

const NUMERIC_KINDS: ColumnKind[] = ['numeric', 'scale'];

/** Whether the sample says this column suits the picker's purpose. A column nothing is known about is not ruled out. */
export function suits(column: TableColumn, described: Described, prefer: ColumnPreference): boolean {
    const d = described.get(column.key);
    switch (prefer) {
        case 'split': return d ? d.usableAsSplit : true;
        case 'numeric': return d ? NUMERIC_KINDS.includes(d.kind) : column.type === 'number' || column.type === 'mixed';
        case 'personal': return !!d && d.looksPersonal;
        default: return true;
    }
}

function kindWord(kind: ColumnKind, t: Translate): string {
    switch (kind) {
        case 'single': return t('automation_tables.kind.single', 'choice');
        case 'multi': return t('automation_tables.kind.multi', 'several choices');
        case 'scale': case 'numeric': return t('automation_tables.kind.numeric', 'number');
        case 'date': return t('automation_tables.kind.date', 'date');
        case 'free_text': return t('automation_tables.kind.free_text', 'free text');
        case 'identifier': return t('automation_tables.kind.identifier', 'identifier');
        default: return '';
    }
}

/** The text of one option: the column's name, what it holds and whether it looks personal. */
export function columnLabel(column: TableColumn, described: Described, t: Translate): string {
    const d = described.get(column.key);
    const parts = [column.label || column.key];
    if (d) {
        const word = kindWord(d.kind, t);
        if (word) parts.push(word);
        if (d.looksPersonal) parts.push(t('automation_tables.column.personal', 'personal data'));
    }
    return parts.join(' · ');
}

interface SelectProps {
    value: string;
    onChange: (key: string) => void;
    /** The columns that can be picked; null when they are not known (then the name is typed). */
    columns: TableColumn[] | null;
    described?: Described;
    prefer?: ColumnPreference;
    ariaLabel: string;
    id?: string;
    invalid?: boolean;
    /** Text of the empty choice; no empty choice when omitted. */
    emptyLabel?: string;
    exclude?: readonly string[];
}

const NONE: Described = new Map();

/**
 * One column, picked from the columns that reach this step. The ones that suit
 * the purpose come first (a split wants a column with a few options, a total
 * wants numbers, a pseudonym wants a column that looks personal); the rest stay
 * available under "Other columns".
 */
export function ColumnSelect({ value, onChange, columns, described = NONE, prefer = 'any', ariaLabel, id, invalid, emptyLabel, exclude = [] }: SelectProps) {
    const { t } = useTranslation();
    const cls = rowInputClass('w-full', { invalid });
    if (!columns) {
        return <input id={id} type="text" aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)} className={cls} placeholder={t('automation_tables.column.type_name', 'Column name')} />;
    }
    const pickable = columns.filter(c => !exclude.includes(c.key) || c.key === value);
    const known = pickable.some(c => c.key === value);
    const suggested = prefer === 'any' ? pickable : pickable.filter(c => suits(c, described, prefer));
    const others = prefer === 'any' ? [] : pickable.filter(c => !suggested.includes(c));
    const option = (c: TableColumn) => <option key={c.key} value={c.key}>{columnLabel(c, described, t as Translate)}</option>;
    return (
        <select id={id} aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)} className={cls}>
            {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
            {emptyLabel === undefined && !value && <option value="" disabled>{t('automation_tables.column.choose', 'Choose a column')}</option>}
            {value && !known && <option value={value}>{t('automation_tables.column.missing', '{name} (not in the table)', { name: value })}</option>}
            {others.length > 0 ? (
                <>
                    <optgroup label={t('automation_tables.column.suggested', 'Suggested')}>{suggested.map(option)}</optgroup>
                    <optgroup label={t('automation_tables.column.others', 'Other columns')}>{others.map(option)}</optgroup>
                </>
            ) : suggested.map(option)}
        </select>
    );
}

/** A column name typed in, for a table whose columns are not known yet; Enter adds it. */
function TypedAdd({ onAdd, ariaLabel, invalid }: { onAdd: (key: string) => void; ariaLabel: string; invalid?: boolean }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const commit = () => { const key = text.trim(); if (key) onAdd(key); setText(''); };
    return (
        <input
            type="text" value={text} onChange={e => setText(e.target.value)} onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
            aria-label={t('automation_tables.column.add_to', 'Add a column to: {field}', { field: ariaLabel })}
            placeholder={t('automation_tables.column.type_name_enter', 'Column name, then Enter')}
            className={rowInputClass('w-full', { invalid })}
        />
    );
}

interface ChipsProps {
    value: string[];
    onChange: (keys: string[]) => void;
    columns: TableColumn[] | null;
    described?: Described;
    prefer?: ColumnPreference;
    ariaLabel: string;
    max?: number;
    invalid?: boolean;
}

/** Several columns, as chips that can be taken away, and a picker to add one more. */
export function ColumnChips({ value, onChange, columns, described = NONE, prefer = 'any', ariaLabel, max, invalid }: ChipsProps) {
    const { t } = useTranslation();
    const full = max !== undefined && value.length >= max;
    return (
        <div className="flex flex-col gap-1.5">
            {value.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
                    {value.map(key => (
                        <li key={key} className="inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] py-0.5 pl-2 pr-1 text-xs text-[var(--text-primary)]">
                            <span>{key}</span>
                            <button
                                type="button"
                                onClick={() => onChange(value.filter(k => k !== key))}
                                aria-label={t('automation_tables.column.remove', 'Remove {name}', { name: key })}
                                className="rounded-full p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                            >
                                <X size={11} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {!full && !columns && <TypedAdd onAdd={key => { if (!value.includes(key)) onChange([...value, key]); }} ariaLabel={ariaLabel} invalid={invalid} />}
            {!full && columns && (
                <ColumnSelect
                    value=""
                    onChange={key => { if (key && !value.includes(key)) onChange([...value, key]); }}
                    columns={columns}
                    described={described}
                    prefer={prefer}
                    ariaLabel={t('automation_tables.column.add_to', 'Add a column to: {field}', { field: ariaLabel })}
                    emptyLabel={t('automation_tables.column.add', 'Add a column…')}
                    exclude={value}
                    invalid={invalid}
                />
            )}
        </div>
    );
}
