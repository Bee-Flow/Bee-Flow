import { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { normaliseOptions } from '../../../../../forms/formOptions';
import { denseInputClass, textareaClass } from '../formPrimitives';
import type { EditorField } from './fieldEditor.types';
import { OP_LABELS, VALUELESS_OPS, buildShowIf, isConditionable, opsFor, parseShowIf, type ShowIfModel, type ShowIfOp } from './showIfModel';

const LABEL = 'text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]';
const LINK = 'text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2';
const MAX_SHOW_IF = 500;

type Change = (changes: Partial<EditorField>) => void;

interface Props {
    field: EditorField;
    /** Zero-based position of the question being edited. */
    index: number;
    /** Every question on the page, in order. Only the ones BEFORE this one can be used. */
    siblings: EditorField[];
    onChange: Change;
}

const CHOICE = ['select', 'radio', 'multiselect'];

/** The value a new condition starts with for a question: its first choice, or "yes". */
function defaultValue(q: EditorField): string {
    if (q.type === 'checkbox') return 'true';
    if (CHOICE.includes(q.type || '')) return normaliseOptions(q.options)[0]?.value || '';
    return '';
}

/** The picks a value can be chosen from (a checkbox, or a question with choices), or null for free input. */
function valueChoices(q: EditorField, t: ReturnType<typeof useTranslation>['t']): { value: string; label: string }[] | null {
    if (q.type === 'checkbox') {
        return [{ value: 'true', label: t('automations.form_wizard.show_if_checked', 'Checked') }, { value: 'false', label: t('automations.form_wizard.show_if_unchecked', 'Not checked') }];
    }
    const options = CHOICE.includes(q.type || '') ? normaliseOptions(q.options) : [];
    return options.length > 0 ? options : null;
}

function Header({ onClear }: { onClear: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between gap-2">
            <span className={LABEL}>{t('automations.form_wizard.show_if_label', 'Only show this question when')}</span>
            <button type="button" onClick={onClear} className={LINK}>{t('automations.form_wizard.show_if_clear', 'Always show it')}</button>
        </div>
    );
}

/** The expression as text: what the picker cannot read, or what the author chose to edit by hand. */
function ShowIfText({ n, stored, onChange, onClear, note, onPicker }: { n: number; stored: string; onChange: Change; onClear: () => void; note: boolean; onPicker: (() => void) | null }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1">
            <Header onClear={onClear} />
            <textarea
                rows={2}
                maxLength={MAX_SHOW_IF}
                aria-label={`Question ${n} condition`}
                value={stored}
                onChange={(e) => onChange({ showIf: e.target.value || undefined })}
                className={`${textareaClass()} font-mono`}
                placeholder={'form.contact == "email"'}
            />
            <p className="text-[10px] text-[var(--text-tertiary)]">
                {t('automations.form_wizard.show_if_text_help', 'Use the name of an earlier question after form., e.g. contains(form.topics, "billing") or !isEmpty(form.company).')}
            </p>
            {note && <p className="text-[10px] text-[var(--text-tertiary)]">{t('automations.form_wizard.show_if_text_only', 'This condition is too detailed for the picker, so it is shown as text.')}</p>}
            {onPicker && <button type="button" onClick={onPicker} className={LINK}>{t('automations.form_wizard.show_if_use_picker', 'Use the picker')}</button>}
        </div>
    );
}

interface PickerProps {
    n: number;
    model: ShowIfModel;
    earlier: EditorField[];
    write: (next: ShowIfModel) => void;
    onClear: () => void;
    onText: () => void;
}

/** question + operator + value, as three selects / a value box. */
function ShowIfPicker({ n, model, earlier, write, onClear, onText }: PickerProps) {
    const { t } = useTranslation();
    const chosen = earlier.find(q => q.name === model.field) || (earlier[0] as EditorField);
    const name = chosen.name as string;
    const choices = valueChoices(chosen, t);
    const kind = chosen.type === 'number' ? 'number' : chosen.type === 'date' ? 'date' : 'text';
    return (
        <div className="space-y-1">
            <Header onClear={onClear} />
            <div className="flex flex-wrap items-center gap-1">
                <select
                    aria-label={`Question ${n} condition question`}
                    value={name}
                    onChange={(e) => {
                        const q = earlier.find(x => x.name === e.target.value) as EditorField;
                        const op = opsFor(q.type).includes(model.op) ? model.op : (opsFor(q.type)[0] as ShowIfOp);
                        write({ field: q.name as string, op, value: defaultValue(q) });
                    }}
                    className={denseInputClass('!w-auto min-w-0 max-w-full')}
                >
                    {earlier.map(q => <option key={q.name} value={q.name}>{q.label || q.name}</option>)}
                </select>
                <select
                    aria-label={`Question ${n} condition operator`}
                    value={model.op}
                    onChange={(e) => write({ ...model, field: name, op: e.target.value as ShowIfOp, value: model.value || defaultValue(chosen) })}
                    className={denseInputClass('!w-auto')}
                >
                    {opsFor(chosen.type).map(op => <option key={op} value={op}>{t(`automations.form_wizard.op_${op}`, OP_LABELS[op])}</option>)}
                </select>
                {!VALUELESS_OPS.includes(model.op) && (choices ? (
                    <select
                        aria-label={`Question ${n} condition value`}
                        value={model.value}
                        onChange={(e) => write({ ...model, field: name, value: e.target.value })}
                        className={denseInputClass('!w-auto min-w-0 max-w-full')}
                    >
                        {!choices.some(o => o.value === model.value) && <option value={model.value}>{model.value}</option>}
                        {choices.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                ) : (
                    <input
                        type={kind}
                        aria-label={`Question ${n} condition value`}
                        value={model.value}
                        onChange={(e) => write({ ...model, field: name, value: e.target.value })}
                        className={denseInputClass('!w-auto min-w-0 flex-1')}
                    />
                ))}
            </div>
            <button type="button" onClick={onText} className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                {t('automations.form_wizard.show_if_edit_text', 'Edit as text')}
            </button>
        </div>
    );
}

/**
 * "Only show this question when…": one condition on an EARLIER question of the
 * same page. The condition is written as an expression the form checks as the
 * visitor answers; a hidden question is not asked, not required and stays empty.
 *
 * Anything already stored that the picker cannot read (a longer expression, a
 * question that moved below this one) shows as text instead, untouched, and
 * can be edited there or cleared.
 */
export default function ShowIfEditor({ field, index, siblings, onChange }: Props) {
    const { t } = useTranslation();
    const earlier = siblings.slice(0, index).filter(q => q?.name && isConditionable(q));
    const stored = typeof field.showIf === 'string' ? field.showIf : '';
    const parsed = parseShowIf(stored, earlier.map(q => q.name as string));
    // A half-finished condition lives here until it is complete enough to write down.
    const [draft, setDraft] = useState<ShowIfModel | null>(null);
    const [adding, setAdding] = useState(false);
    const [asText, setAsText] = useState(false);
    const typeOf = (name: string) => earlier.find(q => q.name === name)?.type;

    if (!stored && !adding) {
        if (earlier.length === 0) return null;
        const start = () => {
            const q = earlier[earlier.length - 1] as EditorField;
            const first: ShowIfModel = { field: q.name as string, op: opsFor(q.type)[0] || 'eq', value: defaultValue(q) };
            setDraft(first);
            setAdding(true);
            const expr = buildShowIf(first, q.type);
            if (expr) onChange({ showIf: expr });
        };
        return (
            <button type="button" onClick={start} className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] underline underline-offset-2">
                + {t('automations.form_wizard.show_if_add', 'Only show this question when…')}
            </button>
        );
    }

    const model: ShowIfModel | null = draft && (!stored || buildShowIf(draft, typeOf(draft.field)) === stored) ? draft : parsed;
    const clear = () => { setDraft(null); setAdding(false); setAsText(false); onChange({ showIf: undefined }); };
    const write = (next: ShowIfModel) => {
        setDraft(next);
        const expr = buildShowIf(next, typeOf(next.field));
        if (expr || stored) onChange({ showIf: expr || undefined });
    };
    const n = index + 1;

    if (asText || !model || earlier.length === 0) {
        const unreadable = !model || earlier.length === 0;
        return (
            <ShowIfText
                n={n}
                stored={stored}
                onChange={onChange}
                onClear={clear}
                note={unreadable && !!stored}
                onPicker={asText && !unreadable ? () => setAsText(false) : null}
            />
        );
    }
    return <ShowIfPicker n={n} model={model} earlier={earlier} write={write} onClear={clear} onText={() => setAsText(true)} />;
}
