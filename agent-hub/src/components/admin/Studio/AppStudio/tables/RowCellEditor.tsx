import React, { useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { boolValue, dateInputValue, listValue, optionPairs } from './rowValues';
import { importableFields } from './spreadsheetPaste';
import type { ImportField } from './spreadsheetPaste';
import type { OptionPair } from './rowValues';

/** The members of a model field a cell editor reads. */
export interface CellField extends ImportField {
    type: string;
}

/** A row of the table a relation points at. */
type RelationRow = Record<string, unknown>;

interface RelationTable {
    fields?: ImportField[];
}

interface ChoiceCellProps {
    field: CellField;
    value: unknown;
    onCommit: (value: string | null) => void;
    disabled: boolean;
    autoFocus: boolean;
    ariaLabel: string;
}

interface MultiChoiceCellProps {
    field: CellField;
    value: unknown;
    onChange?: ((picked: string[]) => void) | null;
    onDone?: ((picked: string[]) => void) | null;
    disabled: boolean;
    ariaLabel: string;
}

interface TypedCellProps {
    field: CellField;
    value: string | number | null | undefined;
    onCommit: (value: string | number | null) => void;
    onCancel?: (() => void) | null;
    disabled: boolean;
    live: boolean;
    autoFocus: boolean;
    label: string;
}

export interface RowCellEditorProps {
    field: CellField;
    value: unknown;
    onCommit: (value: unknown) => void;
    onCancel?: (() => void) | null;
    relationRows?: RelationRow[] | null;
    relationTable?: RelationTable | null;
    disabled?: boolean;
    live?: boolean;
    autoFocus?: boolean;
}

/**
 * App Studio — the editor for ONE cell of ONE row, chosen by the column's type.
 *
 * A column the designer declared as a choice edits as a dropdown, a yes/no as a
 * checkbox and a date as a date picker — a text box for all of them would let a
 * value in that the column cannot hold. A typed value commits on blur or Enter
 * and Escape leaves it as it was (the idiom the runtime's data grid uses for
 * its inline edits); `live` commits every keystroke instead, which is what the
 * not-yet-sent draft row needs.
 */

const CELL_CLS = 'w-full rounded-md px-2 py-1 text-sm border bg-[var(--bg-primary)] '
    + 'border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] '
    + 'focus:border-[var(--accent-primary)]';

const INPUT_TYPE: Record<string, string> = { number: 'number', date: 'date', datetime: 'datetime-local' };

/** The label a relation cell shows for a row of the table it points at. */
function relationLabel(record: RelationRow, targetTable: RelationTable | null | undefined) {
    const textField = importableFields(targetTable?.fields)
        .find((f: ImportField) => (f.type === 'text' || f.type === 'select') && record?.[f.key]);
    if (textField) return String(record[textField.key]);
    return String(record?.id ?? '');
}

function ChoiceCell({ field, value, onCommit, disabled, autoFocus, ariaLabel }: ChoiceCellProps) {
    const options = optionPairs(field);
    const current = value == null ? '' : String(value);
    // A value that is no longer among the choices stays visible instead of
    // silently resetting to blank the next time the cell is touched.
    const extra = current && !options.some((o: OptionPair) => o.value === current) ? [{ value: current, label: current }] : [];
    return (
        <select
            className={CELL_CLS}
            value={current}
            autoFocus={autoFocus}
            disabled={disabled}
            aria-label={ariaLabel}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onCommit(e.target.value === '' ? null : e.target.value)}
        >
            <option value="">—</option>
            {[...options, ...extra].map((o: OptionPair) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    );
}

/**
 * Ticking a choice must not end the edit — a multi-select cell collects its
 * choices locally and hands the whole list over at once (onDone), unless the
 * caller wants every tick (onChange, the draft row).
 */
function MultiChoiceCell({ field, value, onChange, onDone, disabled, ariaLabel }: MultiChoiceCellProps) {
    const { t } = useTranslation();
    const options = optionPairs(field);
    const [picked, setPicked] = useState(() => listValue(value).map(String));
    const toggle = (v: string) => {
        const next = picked.includes(v) ? picked.filter((x: string) => x !== v) : [...picked, v];
        setPicked(next);
        onChange?.(next);
    };
    return (
        <div
            className="flex flex-col gap-1 rounded-md border p-1.5 border-[var(--border-default)] bg-[var(--bg-primary)]"
            role="group"
            aria-label={ariaLabel}
        >
            {options.length === 0 ? (
                <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_tables.cell.no_choices', 'This column has no choices yet.')}</span>
            ) : options.map((o: OptionPair) => (
                <label key={o.value} className="inline-flex items-center gap-1.5 text-xs cursor-pointer text-[var(--text-primary)]">
                    <input
                        type="checkbox"
                        className="accent-[var(--accent-primary)]"
                        checked={picked.includes(o.value)}
                        disabled={disabled}
                        onChange={() => toggle(o.value)}
                    />
                    {o.label}
                </label>
            ))}
            {onDone ? (
                <button
                    type="button"
                    onClick={() => onDone(picked)}
                    className="mt-0.5 self-start rounded-md border px-2 py-0.5 text-xs border-[var(--border-default)] text-[var(--text-secondary)]"
                >
                    {t('studio_apps_tables.cell.done', 'Done')}
                </button>
            ) : null}
        </div>
    );
}

function TypedCell({ field, value, onCommit, onCancel, disabled, live, autoFocus, label }: TypedCellProps) {
    const [draft, setDraft] = useState<string | number>(() => (field.type === 'date' || field.type === 'datetime'
        ? dateInputValue(value, field.type)
        : (value ?? '')));

    const numeric = (raw: string | number | null) => {
        if (raw === '' || raw == null) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    };
    const emit = (raw: string | number | null) => onCommit(field.type === 'number' ? numeric(raw) : (raw === '' ? null : raw));

    return (
        <input
            className={CELL_CLS}
            type={INPUT_TYPE[field.type] || 'text'}
            value={draft ?? ''}
            autoFocus={autoFocus}
            disabled={disabled}
            aria-label={label}
            spellCheck={false}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setDraft(e.target.value);
                if (live) emit(e.target.value);
            }}
            onBlur={live ? undefined : () => emit(draft)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
            }}
        />
    );
}

export default function RowCellEditor({
    field, value, onCommit, onCancel, relationRows, relationTable,
    disabled = false, live = false, autoFocus = false,
}: RowCellEditorProps) {
    const label = `${field.name || field.key}`;

    if (field.type === 'bool') {
        return (
            <input
                type="checkbox"
                className="accent-[var(--accent-primary)]"
                checked={boolValue(value)}
                disabled={disabled}
                aria-label={label}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onCommit(e.target.checked)}
            />
        );
    }
    if (field.type === 'select') {
        return <ChoiceCell field={field} value={value} onCommit={onCommit} disabled={disabled} autoFocus={autoFocus} ariaLabel={label} />;
    }
    if (field.type === 'multiselect') {
        return (
            <MultiChoiceCell
                field={field}
                value={value}
                onChange={live ? onCommit : null}
                onDone={live ? null : onCommit}
                disabled={disabled}
                ariaLabel={label}
            />
        );
    }
    if (field.type === 'relation') {
        const choices = (relationRows || []).map((r: RelationRow) => ({ value: String(r.id), label: relationLabel(r, relationTable) }));
        return (
            <ChoiceCell
                field={{ ...field, options: choices }}
                value={value}
                onCommit={onCommit}
                disabled={disabled}
                autoFocus={autoFocus}
                ariaLabel={label}
            />
        );
    }
    return (
        <TypedCell
            field={field}
            value={value as string | number | null | undefined}
            onCommit={onCommit}
            onCancel={onCancel}
            disabled={disabled}
            live={live}
            autoFocus={autoFocus}
            label={label}
        />
    );
}
