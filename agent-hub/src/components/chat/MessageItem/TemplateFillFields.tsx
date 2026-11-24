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
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import useTranslation from '@/hooks/useTranslation';
import { isEmpty, TO_DO, useGrouping, useReleaseOnLeave, type GroupId } from './templateFillGrouping';
import type { TemplateFillField } from './templateFillTypes';

import { asText, borderClass, inputBase, INPUTS, WIDE_TEXT, type OnChange } from './TemplateFillInputs';


/**
 * The template's default for an empty field. The document prints it when the field is left empty (the server
 * fills a missing value with it), so it says that, and "Accept" puts it in the field to change it from there.
 */
function Suggestion({ field, onChange }: { field: TemplateFillField; onChange: OnChange }) {
    const { t } = useTranslation();
    const shown = typeof field.suggestion === 'boolean'
        ? (field.suggestion ? t('chat_templates.fields_yes', 'Yes') : t('chat_templates.fields_no', 'No'))
        : asText(field.suggestion);
    return (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2 py-1 text-xs"
            data-testid={`template-fill-suggestion-${field.key}`}>
            <span className="shrink-0 text-[var(--text-tertiary)]">{t('chat_templates.fields_default', 'Used if left empty')}:</span>
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

/**
 * Which fields of a group take the whole width: the wide ones, and a short
 * field with no short neighbour to share its row with (the last of an odd
 * run), so no field sits at half width next to an empty half.
 */
function wideFields(fields: TemplateFillField[], wideAlone: (field: TemplateFillField) => boolean): Set<string> {
    const wide = new Set(fields.filter(wideAlone).map((f) => f.key));
    let run: TemplateFillField[] = [];
    const close = () => { if (run.length % 2 === 1) wide.add(run[run.length - 1].key); run = []; };
    for (const f of fields) {
        if (wide.has(f.key)) close();
        else run.push(f);
    }
    close();
    return wide;
}

/** The line of help under a field, unless it only repeats the label. */
const helpOf = (field: TemplateFillField): string => {
    const help = field.help?.trim() ?? '';
    return help.toLowerCase() === field.label.trim().toLowerCase() ? '' : help;
};

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
    const help = helpOf(field);
    if (!help && !offer && !input && !issue) return null;
    return (
        <div className="flex min-w-0 flex-col gap-1.5" onFocusCapture={onTouch}>
            {input}
            {issue && <p id={ids.issue} className="m-0 text-xs text-[var(--error)]">{issue}</p>}
            {help && <p id={ids.help} className="m-0 text-xs text-[var(--text-tertiary)] [overflow-wrap:anywhere]">{help}</p>}
            {offer && <Suggestion field={field} onChange={onChange} />}
        </div>
    );
}

function FieldRow({ field, value, issue, adornment, wide, onChange, onTouch }: {
    field: TemplateFillField; value: unknown; issue?: string; adornment?: FieldAdornment | null;
    /** The whole width of a two-column card (wideFields). */
    wide: boolean;
    onChange: OnChange; onTouch: (key: string) => void;
}) {
    const id = useId();
    const ids = { help: `${id}-help`, issue: `${id}-issue`, details: `${id}-details` };
    const describedBy = [helpOf(field) ? ids.help : '', issue ? ids.issue : ''].filter(Boolean).join(' ') || undefined;
    const aria = { 'aria-invalid': issue ? true : undefined, 'aria-describedby': describedBy };
    const Input = INPUTS[field.type] ?? INPUTS.text;
    const inline = field.type === 'boolean';
    const touch = () => onTouch(field.key);
    const input = <Input id={id} field={field} value={value} className={`${inputBase} ${borderClass(Boolean(issue))}`} aria={aria} onChange={onChange} />;
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
            {groups.map((g) => {
                const extras = new Map(g.fields.map((f) => [f.key, adornments?.(f) ?? null]));
                const wide = wideFields(g.fields, (f) => isWide(f, values[f.key]) || !!extras.get(f.key)?.below);
                return (
                    <FieldGroup key={g.id} id={g.id} title={titles[g.id]} count={g.fields.length} collapsible={settled || (!TO_DO.has(g.id) && toDo)} narrow={narrow}>
                        {g.fields.map((f) => (
                            <FieldRow key={f.key} field={f} value={values[f.key]} issue={issues[f.key]} adornment={extras.get(f.key)} wide={wide.has(f.key)}
                                onChange={change} onTouch={touch} />
                        ))}
                    </FieldGroup>
                );
            })}
        </div>
    );
}
