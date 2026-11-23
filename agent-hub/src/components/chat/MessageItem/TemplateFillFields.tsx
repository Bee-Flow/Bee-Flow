/**
 * The fields of a template being filled in, grouped by what there is to do:
 * "Asked of you" (a colleague waits for it), "To look at" (the final check has
 * a remark), "Still needed", "Filled in" and "Optional"
 * (templateFillGrouping.ts decides where a field is, and when it may move).
 *
 * A field is its label (with the "i" for the full instructions and, at the
 * right, whatever the form adds: asking a colleague, a note), a line of help,
 * the input, and under it what belongs to the value: the reason it was
 * refused, the final check's remark, who filled it in, notes.
 *
 * Text-like inputs keep a local draft and report on blur (or Enter on a single
 * line); a select, switch, date or list reports at once. A list is a small
 * table with one row per item.
 */
import { createContext, useContext, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import useTranslation from '@/hooks/useTranslation';
import { isEmpty, TO_DO, useGrouping, useReleaseOnLeave, type GroupId } from './templateFillGrouping';
import type { TemplateFillField } from './templateFillTypes';

type OnChange = (key: string, value: unknown) => void;
type Row = Record<string, unknown>;

/** From this length a text is several lines high, where the browser does not size the box to its content itself. */
const LONG_TEXT = 80;
/** From this length a text no longer fits half the card: the field takes the whole width. */
const WIDE_TEXT = 36;

const asText = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

const inputBase = 'w-full rounded-lg border bg-[var(--bg-primary)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] '
    + 'placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-primary)] focus:ring-2 '
    + 'focus:ring-[color-mix(in_srgb,var(--accent-primary)_25%,transparent)]';

/** One quiet border for every field; red only where the server refused the value. */
const borderClass = (issue: boolean): string => (issue ? 'border-[var(--error)]' : 'border-[var(--border-default)]');

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

/** The template's default for an empty field: shown, and filled in only when the person accepts it. */
function Suggestion({ field, onChange }: { field: TemplateFillField; onChange: OnChange }) {
    const { t } = useTranslation();
    const shown = typeof field.suggestion === 'boolean'
        ? (field.suggestion ? t('chat_templates.fields_yes', 'Yes') : t('chat_templates.fields_no', 'No'))
        : asText(field.suggestion);
    return (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-1 text-xs"
            data-testid={`template-fill-suggestion-${field.key}`}>
            <span className="shrink-0 text-[var(--text-tertiary)]">{t('chat_templates.fields_suggestion', 'Suggestion')}:</span>
            <span className="min-w-0 truncate text-[var(--text-secondary)]">{shown}</span>
            <button type="button" onClick={() => onChange(field.key, field.suggestion)}
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium text-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]">
                {t('chat_templates.fields_accept', 'Accept')}
            </button>
        </div>
    );
}

/** Whether a field's full instructions are open: shared by the "i" in the label line and the text under it. */
const DetailsContext = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} });

function DetailsState({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    return <DetailsContext.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>{children}</DetailsContext.Provider>;
}

/** The small "i" that opens the full instructions of a field, so the form stays short. */
function DetailsToggle({ id }: { id: string }) {
    const { t } = useTranslation();
    const { open, toggle } = useContext(DetailsContext);
    const label = t('chat_templates.fields_more', 'More about this field');
    return (
        <button type="button" aria-expanded={open} aria-controls={id} onClick={toggle} title={label}
            className="ml-1.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] text-[10px] leading-none text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
            <span aria-hidden="true">i</span><span className="sr-only">{label}</span>
        </button>
    );
}

function DetailsText({ id, text }: { id: string; text: string }) {
    const { open } = useContext(DetailsContext);
    if (!open) return null;
    return <p id={id} className="m-0 whitespace-pre-line rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)]">{text}</p>;
}

/** Long text and lists take the whole width; the short fields share a row on a wide card. */
const isWide = (field: TemplateFillField, value: unknown): boolean => field.type === 'list'
    || (field.type === 'text' && asText(value).length > WIDE_TEXT);

function RequiredMark() {
    const { t } = useTranslation();
    return (
        <>
            <span aria-hidden="true" className="ml-0.5 text-[var(--accent-primary)]">*</span>
            <span className="sr-only">{t('chat_templates.fields_required', 'required')}</span>
        </>
    );
}

/** What the form adds to a field: at the right of its label, and under its input. */
export interface FieldAdornment {
    actions?: ReactNode;
    below?: ReactNode;
}

/**
 * The label line: name, required mark, the "i" for the full instructions, a
 * switch beside it, and at the right what the form adds (`actions`). Working
 * in the field itself holds it in place (`onTouch`); the form's buttons at
 * the right do not.
 */
function FieldHead({ id, field, input, actions, onTouch }: {
    id: string; field: TemplateFillField; input: ReactNode | null; actions?: ReactNode; onTouch: () => void;
}) {
    return (
        <div className="flex items-start gap-1.5">
            <div className={`flex min-w-0 flex-1 flex-wrap items-center ${input ? 'justify-between gap-2' : ''}`} onFocusCapture={onTouch}>
                <span className="flex min-w-0 items-center">
                    <label htmlFor={id} className="text-[13px] font-medium text-[var(--text-primary)]">
                        {field.label}
                        {field.required && <RequiredMark />}
                    </label>
                    {field.details && <DetailsToggle id={`${id}-details`} />}
                </span>
                {input}
            </div>
            {actions}
        </div>
    );
}

/**
 * Under the label: the input, the reason a value was refused, the line of help and the template's suggestion. The
 * input comes first, so labels and inputs line up across the two columns whether a field has help or not.
 */
function FieldBody({ field, value, issue, ids, input, onChange, onTouch }: {
    field: TemplateFillField; value: unknown; issue?: string; ids: { help: string; issue: string };
    /** Null for a switch: it sits in the label line. */
    input: ReactNode | null; onChange: OnChange; onTouch: () => void;
}) {
    const offer = isEmpty(value) && field.suggestion !== undefined;
    if (!field.help && !offer && !input && !issue) return null;
    return (
        <div className="flex min-w-0 flex-col gap-1.5" onFocusCapture={onTouch}>
            {input}
            {issue && <p id={ids.issue} className="m-0 text-xs text-[var(--error)]">{issue}</p>}
            {field.help && <p id={ids.help} className="m-0 text-xs text-[var(--text-tertiary)]">{field.help}</p>}
            {offer && <Suggestion field={field} onChange={onChange} />}
        </div>
    );
}

function FieldRow({ field, value, issue, adornment, onChange, onTouch }: {
    field: TemplateFillField; value: unknown; issue?: string; adornment?: FieldAdornment | null; onChange: OnChange; onTouch: (key: string) => void;
}) {
    const id = useId();
    const ids = { help: `${id}-help`, issue: `${id}-issue`, details: `${id}-details` };
    const describedBy = [field.help ? ids.help : '', issue ? ids.issue : ''].filter(Boolean).join(' ') || undefined;
    const aria = { 'aria-invalid': issue ? true : undefined, 'aria-describedby': describedBy };
    const Input = INPUTS[field.type] ?? TextLikeInput;
    const inline = field.type === 'boolean';
    const touch = () => onTouch(field.key);
    const input = <Input id={id} field={field} value={value} className={`${inputBase} ${borderClass(Boolean(issue))}`} aria={aria} onChange={onChange} />;
    const wide = isWide(field, value) || !!adornment?.below;
    return (
        <div className={`flex min-w-0 flex-col gap-1.5 ${wide ? 'sm:col-span-2' : ''}`} data-testid={`template-fill-field-${field.key}`}
            data-fill-field={field.key}>
            <DetailsState>
                <FieldHead id={id} field={field} input={inline ? input : null} actions={adornment?.actions} onTouch={touch} />
                {field.details && <DetailsText id={ids.details} text={field.details} />}
            </DetailsState>
            <FieldBody field={field} value={value} issue={issue} ids={ids} input={inline ? null : input} onChange={onChange} onTouch={touch} />
            {adornment?.below}
        </div>
    );
}

/** The dot in front of a group's name: what kind of attention the group asks for. */
const GROUP_DOT: Record<GroupId, string> = {
    asked: 'bg-[var(--warning)]', remarked: 'bg-[var(--accent-primary)]', missing: 'border-2 border-[var(--accent-primary)]',
    filled: 'bg-[var(--success)]', optional: 'border border-[var(--border-default)]',
};

/** A group of fields; "Filled in" and "Optional" are folded away while something is still to do, until the person opens them. */
function FieldGroup({ id, title, count, collapsible, narrow, children }: {
    id: GroupId; title: string; count: number; collapsible: boolean; narrow: boolean; children: ReactNode;
}) {
    const [toggled, setToggled] = useState<boolean | null>(null);
    const open = toggled ?? !collapsible;
    const bodyId = useId();
    const heading = 'm-0 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]';
    const name = (
        <>
            <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${GROUP_DOT[id]}`} />
            <span>{title} <span className="font-normal text-[var(--text-tertiary)]">({count})</span></span>
        </>
    );
    return (
        <section aria-label={title} data-testid={`template-fill-group-${id}`} className="flex flex-col gap-3">
            {collapsible ? (
                <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setToggled(!open)}
                    className={`${heading} -mx-1.5 rounded-md px-1.5 py-1 text-left hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]`}>
                    {name}
                    <ChevronRight size={13} aria-hidden="true" className={`ml-auto shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                </button>
            ) : <h4 className={heading}>{name}</h4>}
            {open && <div id={bodyId} className={`grid grid-cols-1 gap-x-3 gap-y-4 ${narrow ? '' : 'sm:grid-cols-2'}`}>{children}</div>}
        </section>
    );
}

export default function TemplateFillFields({ fields, values, issues, saving, asked, remarked, adornments, narrow = false, settled = false, onChange }: {
    fields: TemplateFillField[]; values: Record<string, unknown>; issues: Record<string, string>; saving?: boolean;
    /** One field per row, whatever the width of the window: the form sits in a narrow column (the editor's side panel). */
    narrow?: boolean;
    /** The filling in is finished: the fields are folded away (and open on a click), what is left to do is below them. */
    settled?: boolean;
    /** The fields a colleague asked this person for: shown first. */
    asked?: ReadonlySet<string>;
    /** The fields the final check has a remark on: shown next. */
    remarked?: ReadonlySet<string>;
    /** What the form adds at a field: the remark, who filled it in, notes, asking a colleague. */
    adornments?: (field: TemplateFillField) => FieldAdornment | null;
    onChange: (key: string, value: unknown) => void;
}) {
    const { t } = useTranslation();
    const titles: Record<GroupId, string> = {
        asked: t('chat_templates.fields_group_asked', 'Asked of you'),
        remarked: t('chat_templates.fields_group_remarked', 'To look at'),
        missing: t('chat_templates.fields_group_missing', 'Still needed'),
        filled: t('chat_templates.fields_group_filled', 'Filled in'),
        optional: t('chat_templates.fields_group_optional', 'Optional'),
    };
    const { groups, touch, release } = useGrouping(fields, values, { asked, remarked });
    // Focus that leaves the fields altogether (to a button of the form, to the chat) ends the holding in place.
    const leave = useReleaseOnLeave(release);
    const toDo = groups.some((g) => TO_DO.has(g.id));
    const change = (key: string, value: unknown) => { touch(key); onChange(key, value); };
    return (
        <div className="relative flex flex-col gap-5" data-testid="template-fill-fields" onBlur={leave.onBlur} onFocus={leave.onFocus}>
            {saving && (
                <span className="absolute right-0 top-0 text-xs text-[var(--text-tertiary)]" role="status">
                    {t('chat_templates.fields_saving', 'Saving…')}
                </span>
            )}
            {groups.map((g) => (
                <FieldGroup key={g.id} id={g.id} title={titles[g.id]} count={g.fields.length} collapsible={settled || (!TO_DO.has(g.id) && toDo)} narrow={narrow}>
                    {g.fields.map((f) => (
                        <FieldRow key={f.key} field={f} value={values[f.key]} issue={issues[f.key]} adornment={adornments?.(f)} onChange={change} onTouch={touch} />
                    ))}
                </FieldGroup>
            ))}
        </div>
    );
}
