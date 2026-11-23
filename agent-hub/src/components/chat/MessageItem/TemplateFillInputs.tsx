/**
 * The inputs of a template field (text, number, date, switch, choice and the
 * list table) and the small helpers they share. Split out of
 * TemplateFillFields.tsx, which lays the fields out.
 */
import { useState, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';

import { FILL_SMALL } from '@/components/documents/fill/fillStyles';
import useTranslation from '@/hooks/useTranslation';
import type { TemplateFillField } from './templateFillTypes';

export type OnChange = (key: string, value: unknown) => void;
type Row = Record<string, unknown>;

/** From this length a text is several lines high, where the browser does not size the box to its content itself. */
const LONG_TEXT = 80;
/** From this length a text no longer fits half the card: the field takes the whole width. */
export const WIDE_TEXT = 36;

export const asText = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

export const inputBase = 'w-full rounded-lg border bg-[var(--bg-primary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] '
    + 'placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-primary)] focus:ring-2 '
    + 'focus:ring-[color-mix(in_srgb,var(--accent-primary)_25%,transparent)]';

/** One quiet border for every field; red only where the server refused the value. */
export const borderClass = (issue: boolean): string => (issue ? 'border-[var(--error)]' : 'border-[var(--border-default)]');

function toNumber(draft: string): number | undefined {
    if (draft.trim() === '') return undefined;
    const n = Number(draft);
    return Number.isFinite(n) ? n : undefined;
}

/** A draft that follows the stored value until the person types, and resets when the value changes elsewhere. */
function useDraft(value: string) {
    const [draft, setDraft] = useState(value);
    const [seen, setSeen] = useState(value);
    if (seen !== value) {
        setSeen(value);
        // A value from elsewhere (a colleague, the assistant) replaces the field only while the person is
        // not typing in it: unsaved typing stays, and is what the next save sends.
        if (draft === seen) setDraft(value);
    }
    return [draft, setDraft] as const;
}

interface InputProps {
    id: string;
    field: TemplateFillField;
    value: unknown;
    className: string;
    aria: { 'aria-invalid'?: boolean; 'aria-describedby'?: string };
    onChange: OnChange;
}

/**
 * A number is a one-line input. A text is ONE box from the first letter to the last: it starts a line high and
 * grows with what is typed (or, where the browser cannot size a box to its content, is four lines high once the
 * text is long). It never turns into another element while someone types in it, so the cursor is never lost.
 * Enter is "done with this field"; Shift+Enter is a new line.
 */
function TextLikeInput({ id, field, value, className, aria, onChange }: InputProps) {
    const stored = asText(value);
    const [draft, setDraft] = useDraft(stored);
    const isNumber = field.type === 'number';
    const commit = () => {
        if (draft === stored) return;
        onChange(field.key, isNumber ? toNumber(draft) : draft);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    };
    const common = { id, placeholder: field.example, value: draft, onBlur: commit, onKeyDown, ...aria };
    if (isNumber) return <input {...common} className={className} type="number" onChange={(e) => setDraft(e.target.value)} />;
    const long = draft.length > LONG_TEXT || draft.includes('\n');
    return (
        <textarea {...common} rows={long ? 4 : 1} onChange={(e) => setDraft(e.target.value)}
            className={`${className} block max-h-40 resize-none field-sizing-content`} />
    );
}

function SwitchInput({ id, field, value, aria, onChange }: InputProps) {
    const on = value === true;
    return (
        <button id={id} type="button" role="switch" aria-checked={on} {...aria}
            onClick={() => onChange(field.key, !on)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-[var(--border-subtle)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] ${on ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)]'}`}>
            <span className={`inline-block h-4 w-4 rounded-full bg-[var(--bg-primary)] shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
    );
}

function ChoiceInput({ id, field, value, className, aria, onChange }: InputProps) {
    return (
        <select id={id} className={className} value={asText(value)} {...aria}
            onChange={(e) => onChange(field.key, e.target.value === '' ? undefined : e.target.value)}>
            <option value="" />
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
    );
}

function DateInput({ id, field, value, className, aria, onChange }: InputProps) {
    return (
        <input id={id} type="date" className={className} value={asText(value)} {...aria}
            onChange={(e) => onChange(field.key, e.target.value === '' ? undefined : e.target.value)} />
    );
}

/** The columns of a list; a list without sub-fields is one text column holding plain strings. */
function columnsOf(field: TemplateFillField): { columns: TemplateFillField[]; plain: boolean } {
    if (field.fields && field.fields.length > 0) return { columns: field.fields, plain: false };
    return { columns: [{ key: 'value', label: field.label, type: 'text', required: false }], plain: true };
}

function ListInput({ id, field, value, aria, onChange }: InputProps) {
    const { t } = useTranslation();
    const { columns, plain } = columnsOf(field);
    const items: unknown[] = Array.isArray(value) ? value : [];
    const rows: Row[] = items.map((it) => (plain ? { value: it } : (it && typeof it === 'object' ? it as Row : {})));
    const send = (next: Row[]) => onChange(field.key, plain ? next.map((r) => r.value ?? '') : next);
    const setCell = (i: number, col: TemplateFillField, raw: string) => {
        const cell = col.type === 'number' ? toNumber(raw) : raw;
        send(rows.map((r, j) => (j === i ? { ...r, [col.key]: cell } : r)));
    };
    const cellClass = `${inputBase} border-[var(--border-default)]`;
    // A frame round the rows, dashed while there are none, so an empty list still reads as a place to fill in.
    const frame = rows.length > 0 ? 'border-[var(--border-default)]' : 'border-dashed border-[var(--border-default)]';
    return (
        <div id={id} role="group" aria-label={field.label} {...aria} className={`flex min-w-0 flex-col gap-2 rounded-lg border p-2 ${frame}`}>
            {rows.length > 0 && (
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr>{columns.map((c) => <th key={c.key} scope="col" className="px-1 pb-1 text-left text-xs font-medium text-[var(--text-secondary)]">{c.label}</th>)}<th /></tr>
                    </thead>
                    <tbody>
                        {rows.map((row, i) => (
                            <tr key={i}>
                                {columns.map((c) => (
                                    <td key={c.key} className="px-1 py-0.5">
                                        <input aria-label={`${c.label} ${i + 1}`} type={c.type === 'number' ? 'number' : 'text'}
                                            className={cellClass} placeholder={c.example} value={asText(row[c.key])}
                                            onChange={(e) => setCell(i, c, e.target.value)} />
                                    </td>
                                ))}
                                <td className="px-1 py-0.5 text-right">
                                    <button type="button" onClick={() => send(rows.filter((_, j) => j !== i))}
                                        className="rounded px-1 text-xs text-[var(--text-secondary)] hover:text-[var(--error)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
                                        {t('chat_templates.fields_remove_row', 'Remove')}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <button type="button" onClick={() => send([...rows, plain ? { value: '' } : {}])}
                className={`${FILL_SMALL} inline-flex items-center gap-1 self-start border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]`}>
                <Plus size={13} aria-hidden="true" />{t('chat_templates.fields_add_row', 'Add row')}
            </button>
        </div>
    );
}

export const INPUTS = {
    text: TextLikeInput, number: TextLikeInput, date: DateInput, boolean: SwitchInput, choice: ChoiceInput, list: ListInput,
} as const;
