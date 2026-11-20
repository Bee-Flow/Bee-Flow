/**
 * The fields of a template being filled in, grouped as "Still needed",
 * "Filled in" and "Optional" as they stood when the form opened. Text-like inputs keep a local draft and report
 * on blur (or Enter on a single line); a select, switch, date or list reports
 * at once. A list is a small table with one row per item.
 */
import { useId, useState, type KeyboardEvent } from 'react';

import useTranslation from '@/hooks/useTranslation';
import type { TemplateFillField } from './templateFillTypes';

type OnChange = (key: string, value: unknown) => void;
type Row = Record<string, unknown>;

const LONG_TEXT = 80;

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === ''
    || (Array.isArray(v) && v.length === 0);

const asText = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

const inputBase = 'w-full rounded-md border bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)] '
    + 'placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]';

function borderClass(missing: boolean, issue: boolean): string {
    if (issue) return 'border-[var(--error)]';
    return missing ? 'border-[var(--accent-primary)]' : 'border-[var(--border-subtle)]';
}

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
        setDraft(value);
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

function TextLikeInput({ id, field, value, className, aria, onChange }: InputProps) {
    const stored = asText(value);
    const [draft, setDraft] = useDraft(stored);
    const isNumber = field.type === 'number';
    const multiline = !isNumber && (draft.length > LONG_TEXT || draft.includes('\n'));
    const commit = () => {
        if (draft === stored) return;
        onChange(field.key, isNumber ? toNumber(draft) : draft);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
    };
    const common = { id, className, placeholder: field.example, value: draft, onBlur: commit, ...aria };
    if (multiline) {
        return <textarea {...common} rows={4} onChange={(e) => setDraft(e.target.value)} />;
    }
    return (
        <input {...common} type={isNumber ? 'number' : 'text'} onKeyDown={onKeyDown}
            onChange={(e) => setDraft(e.target.value)} />
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
    const cellClass = `${inputBase} border-[var(--border-subtle)]`;
    return (
        <div id={id} role="group" aria-label={field.label} {...aria} className="flex flex-col gap-1">
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
                className="self-start rounded px-1 text-xs text-[var(--accent-primary)] hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
                {t('chat_templates.fields_add_row', 'Add row')}
            </button>
        </div>
    );
}

const INPUTS = {
    text: TextLikeInput, number: TextLikeInput, date: DateInput, boolean: SwitchInput, choice: ChoiceInput, list: ListInput,
} as const;

function FieldRow({ field, value, issue, onChange }: { field: TemplateFillField; value: unknown; issue?: string; onChange: OnChange }) {
    const { t } = useTranslation();
    const id = useId();
    const helpId = `${id}-help`;
    const issueId = `${id}-issue`;
    const describedBy = [field.help ? helpId : '', issue ? issueId : ''].filter(Boolean).join(' ') || undefined;
    const aria = { 'aria-invalid': issue ? true : undefined, 'aria-describedby': describedBy };
    const missing = field.required && isEmpty(value);
    const Input = INPUTS[field.type] ?? TextLikeInput;
    const className = `${inputBase} ${borderClass(missing, Boolean(issue))}`;
    const inline = field.type === 'boolean';
    return (
        <div className="flex flex-col gap-1" data-testid={`template-fill-field-${field.key}`}>
            <div className={inline ? 'flex items-center justify-between gap-2' : 'flex flex-col gap-1'}>
                <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">
                    {field.label}
                    {field.required && <span className="ml-1 text-xs font-normal text-[var(--accent-primary)]">{t('chat_templates.fields_required', 'required')}</span>}
                </label>
                {inline && <Input id={id} field={field} value={value} className={className} aria={aria} onChange={onChange} />}
            </div>
            {field.help && <p id={helpId} className="m-0 text-xs text-[var(--text-secondary)]">{field.help}</p>}
            {!inline && <Input id={id} field={field} value={value} className={className} aria={aria} onChange={onChange} />}
            {issue && <p id={issueId} className="m-0 text-xs text-[var(--error)]">{issue}</p>}
        </div>
    );
}

type GroupId = 'missing' | 'filled' | 'optional';

function groupOf(field: TemplateFillField, values: Record<string, unknown>): GroupId {
    if (!isEmpty(values[field.key])) return 'filled';
    return field.required ? 'missing' : 'optional';
}

export default function TemplateFillFields({ fields, values, issues, saving, onChange }: {
    fields: TemplateFillField[]; values: Record<string, unknown>; issues: Record<string, string>; saving?: boolean;
    onChange: (key: string, value: unknown) => void;
}) {
    const { t } = useTranslation();
    const titles: Record<GroupId, string> = {
        missing: t('chat_templates.fields_group_missing', 'Still needed'),
        filled: t('chat_templates.fields_group_filled', 'Filled in'),
        optional: t('chat_templates.fields_group_optional', 'Optional'),
    };
    // The groups as they stood when the form opened: a field that gets a value stays where it is
    // (no jump, no remount, focus kept) until the form is opened again from the server.
    const [opened] = useState(() => new Map(fields.map((f) => [f.key, groupOf(f, values)])));
    const groups = (['missing', 'filled', 'optional'] as const)
        .map((id) => ({ id, fields: fields.filter((f) => (opened.get(f.key) ?? groupOf(f, values)) === id) }))
        .filter((g) => g.fields.length > 0);
    return (
        <div className="relative flex flex-col gap-4" data-testid="template-fill-fields">
            {saving && (
                <span className="absolute right-0 top-0 text-xs text-[var(--text-tertiary)]" role="status">
                    {t('chat_templates.fields_saving', 'Saving…')}
                </span>
            )}
            {groups.map((g) => (
                <section key={g.id} aria-label={titles[g.id]} data-testid={`template-fill-group-${g.id}`} className="flex flex-col gap-3">
                    <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{titles[g.id]}</h4>
                    {g.fields.map((f) => (
                        <FieldRow key={f.key} field={f} value={values[f.key]} issue={issues[f.key]} onChange={onChange} />
                    ))}
                </section>
            ))}
        </div>
    );
}
