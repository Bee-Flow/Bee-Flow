import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { slugifyFieldName } from './FormBuilderFields';
import { controlSurfaceClass, FormRow } from './formPrimitives';
import type { ApprovalQuestionRow, SetDraft } from './approvalTypes';

/** The stored `{ value, label }` choices as the comma-separated line we show. */
type StoredChoice = string | { label?: unknown; value?: unknown } | null | undefined;
const joinChoices = (options: unknown): string => (Array.isArray(options) ? options as StoredChoice[] : [])
    .map(o => (typeof o === 'object' && o !== null ? (o.label ?? o.value ?? o) : o))
    .filter(Boolean)
    .join(', ');

/** The reverse: what the author typed, back as the list of choice labels. */
const splitChoices = (text: string): string[] => text.split(',').map(x => x.trim()).filter(Boolean);

/**
 * The choices for a "Choice" question, as one comma-separated line.
 *
 * It keeps its OWN text rather than deriving it from the stored array. The
 * array is trimmed and blank-free, so a re-join drops the comma the instant it
 * is typed: the write-back is synchronous, the value recomputes without that
 * character, and React re-asserts node.value — the keystroke is reverted on
 * its own event, so a second choice can only ever be pasted in. Same mechanism
 * and same cure as the form builder's "Choices (one per line)" box.
 */
export function ApprovalChoicesInput({ options, onChange }: { options: unknown; onChange: (options: Array<{ value: string; label: string }>) => void }) {
    const { t } = useTranslation();
    const joined = joinChoices(options);
    const [text, setText] = useState(joined);
    // Our own echo round-trips to the same list; only an edit from outside (an
    // undo, the AI builder, a removed question reusing this index) differs.
    if (splitChoices(text).join(', ') !== splitChoices(joined).join(', ')) setText(joined);
    return (
        <input
            type="text"
            value={text}
            onChange={(e) => {
                setText(e.target.value);
                onChange(splitChoices(e.target.value).map(x => ({ value: x, label: x })));
            }}
            placeholder={t('automations.approval_editors.choices_comma_separated', 'Choices, comma-separated')}
            className={controlSurfaceClass('w-full px-2 py-1.5 text-sm')}
        />
    );
}

/**
 * The placeholder name "Add a question" mints — q1, q2, … — before the author
 * has typed a label. It is the one name approvalQuestionName is allowed to
 * overwrite: nothing downstream can be binding it yet, because the question it
 * belongs to has no label and so cannot have been wired up by anyone.
 */
const PLACEHOLDER_QUESTION_NAME = /^q\d+$/;

/**
 * The name a question ACTUALLY carries right now, or '' when it has none.
 * Separate from approvalQuestionName because the two answer different
 * questions: what would be minted, versus what a later step would bind today.
 * Only the second one is safe to print. Not exported: it is a reading of a
 * row this file already has in hand, not a rule anyone outside needs.
 */
function storedQuestionName(question: ApprovalQuestionRow | null | undefined): string {
    return typeof question?.name === 'string' ? question.name.trim() : '';
}

/**
 * A question's BINDING NAME — minted ONCE, from the label, the first time the
 * question gets one, and never re-derived afterwards.
 *
 * A question has two names, exactly like a form field. The LABEL is what the
 * approver reads and may be reworded freely; `name` is the binding — later
 * steps read the answer as `steps.<id>.output.answers.<name>`.
 *
 * This box used to re-slug the name on EVERY keystroke in the label, which is
 * the trap the form builder's own header calls out by name (FormBuilderFields
 * idea 3, and the whole reason flow/renameFormField.js exists): tightening
 * "Invoice number" to "Invoice number (from the PO)" silently renamed
 * output.answers.invoice_number to output.answers.invoice_number_from_the_po.
 * Nothing failed anywhere — the approver was still asked, still typed the
 * number, and the answer was still recorded against the snapshot — the later
 * step that binds it just quietly started receiving nothing. A field whose
 * answer is silently dropped on the way to the step that needed it is worse
 * than no field at all, which is the one outcome this whole section exists to
 * avoid. (The `nameManual` flag that was meant to stop this was read here and
 * written nowhere, so it never once evaluated true.)
 *
 * The old slug could also be REFUSED outright. It stripped leading underscores
 * but not leading digits, so "2nd signature" minted `2nd_signature`, which the
 * server's PARAM_NAME_RE rejects (a name starts with a letter). Save-time
 * validation reports that as a field-name error naming a string the author
 * never typed and had no box to correct — and had such a definition ever
 * reached a run by another door, normalizeFields skips a field whose name it
 * cannot accept, so the approver would not have been asked the question at all.
 * slugifyFieldName is the form builder's own minting function: it always yields
 * a legal identifier, and it de-duplicates against the names already in use, so
 * two questions both labelled "Amount" become `amount` and `amount_2` instead
 * of one pair of duplicates the server refuses to save.
 *
 * No rename box here, deliberately. The form builder only offers one where it
 * can carry the automation with it (`onRenameField`, which rewrites every ref,
 * template and expression in the same edit); this editor has no such callback,
 * and an editable name that silently breaks bindings is the very bug above
 * wearing a different hat. The name is SHOWN instead, so the author can see
 * what to bind.
 */
export function approvalQuestionName(question: ApprovalQuestionRow | null | undefined, index: number, questions: Array<ApprovalQuestionRow | null | undefined> = []): string {
    const current = storedQuestionName(question);
    // Anything other than the untouched placeholder is a name that is already
    // in play — a later step may be binding it — so it is frozen.
    if (current && !PLACEHOLDER_QUESTION_NAME.test(current)) return current;
    const label = typeof question?.label === 'string' ? question.label.trim() : '';
    if (!label) return current || `q${index + 1}`;
    const taken = new Set(
        questions.map((q, i) => (i === index ? null : q?.name)).filter(Boolean),
    );
    return slugifyFieldName(label, taken);
}

/** "Questions for the approver": extra answers collected with the decision. */
export function ApprovalQuestionsField({ questions, set }: { questions: ApprovalQuestionRow[]; set: SetDraft }) {
    const { t } = useTranslation();
    const setQuestion = (i: number, patchRow: Partial<ApprovalQuestionRow>) => {
        const next = questions.map((row, idx) => (idx === i ? { ...row, ...patchRow } : row));
        set('approvalFields', next);
    };
    return (
        <FormRow
            label={t('automations.approval_editors.questions_for_the_approver', 'Questions for the approver')}
            hint={t('automations.approval_editors.extra_answers_collected_with_the_decision', 'Extra answers collected with the decision — later steps can use them as this step\'s output.answers. Up to 20.')}
        >
            <div className="space-y-1.5">
                {questions.map((q, i) => (
                    <div key={i} className="flex items-center gap-1.5 flex-wrap">
                        <input
                            type="text"
                            value={q.label || ''}
                            onChange={(e) => setQuestion(i, { label: e.target.value })}
                            // The name is minted when the author LEAVES the label box,
                            // not while they are still typing in it: slugging every
                            // keystroke would freeze the binding on the first letter,
                            // and re-slugging every keystroke is the silent-rename bug
                            // approvalQuestionName documents. One mint, on the way out.
                            onBlur={() => {
                                const name = approvalQuestionName(q, i, questions);
                                if (name !== q.name) setQuestion(i, { name });
                            }}
                            placeholder={t('automations.approval_editors.question_label', 'Question label')}
                            className={controlSurfaceClass('flex-1 min-w-[8rem] px-2 py-1.5 text-sm')}
                        />
                        <select
                            value={q.type || 'text'}
                            onChange={(e) => setQuestion(i, { type: e.target.value })}
                            aria-label={t('automations.approval_editors.answer_type', 'Answer type')}
                            className={controlSurfaceClass('w-auto shrink-0 px-2 py-1.5 text-sm')}
                        >
                            <option value="text">{t('automations.approval_editors.short_text', 'Short text')}</option>
                            <option value="textarea">{t('automations.approval_editors.long_text', 'Long text')}</option>
                            <option value="number">{t('automations.approval_editors.number', 'Number')}</option>
                            <option value="date">{t('automations.approval_editors.date', 'Date')}</option>
                            <option value="select">{t('automations.approval_editors.choice', 'Choice')}</option>
                            <option value="checkbox">Yes/no</option>
                            <option value="email">{t('automations.approval_editors.email', 'Email')}</option>
                        </select>
                        <label className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                            <input
                                type="checkbox"
                                checked={!!q.required}
                                onChange={(e) => setQuestion(i, { required: e.target.checked })}
                                className="h-3.5 w-3.5"
                            />
                            {t('automations.approval_editors.required', 'required')}
                        </label>
                        <button
                            type="button"
                            aria-label={t('automations.approval_editors.remove_question', 'Remove question')}
                            onClick={() => set('approvalFields', questions.filter((_, idx) => idx !== i))}
                            className="p-1.5 text-[var(--text-tertiary)] hover:text-red-500 transition"
                        >
                            <Trash2 size={14} />
                        </button>
                        {q.type === 'select' && (
                            <ApprovalChoicesInput
                                options={q.options}
                                onChange={(options) => setQuestion(i, { options })}
                            />
                        )}
                        {/* The binding, spelled out. Read-only for the reason
                            approvalQuestionName gives — there is no rename here that
                            could carry the automation's references with it — but an
                            author who cannot SEE the name cannot bind it either,
                            and used to have to guess at the slug.

                            It prints what is STORED, not what the next mint would
                            produce. The mint happens when the label box is LEFT, so
                            between the first keystroke and that blur the stored name
                            is still `q1` — and the autosave debounce saves inside
                            that window. Printing the slug the author is about to get
                            would tell them to bind output.answers.invoice_number
                            while the definition says q1, and a panel closed with
                            Escape unmounts the input without ever firing the blur
                            that would have made the line true. A later step wired
                            from a line like that receives nothing, with no error
                            anywhere — the same silent drop the minting rules above
                            exist to prevent, reached through the hint instead of
                            through a rename. A question that has no name at all
                            (an AI-built one: normalizeApprovalConfig passes fields
                            through without minting, deliberately, because shape is
                            validate.js's job) has nothing stored to be honest about,
                            so it falls back to the prospective mint — which is also
                            exactly what touching the label box will store. */}
                        <p className="w-full text-[11px] text-[var(--text-tertiary)]">
                            {t('automations.approval_editors.later_steps_read_this_answer_as', 'Later steps read this answer as')}{' '}
                            <code>output.answers.{storedQuestionName(q) || approvalQuestionName(q, i, questions)}</code>
                        </p>
                    </div>
                ))}
                {questions.length < 20 && (
                    <button
                        type="button"
                        // The placeholder is positional, so it has to skip the names
                        // already on the list: removing question 1 of 2 and adding a
                        // new one used to mint a second `q2`, and two questions
                        // sharing a name is a save-time error (field_name_duplicate)
                        // about a name the author never typed.
                        onClick={() => {
                            const taken = new Set(questions.map(q => q?.name).filter(Boolean));
                            let n = questions.length + 1;
                            while (taken.has(`q${n}`)) n += 1;
                            set('approvalFields', [...questions, { name: `q${n}`, label: '', type: 'text', required: false }]);
                        }}
                        className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                    >
                        <Plus size={12} /> {t('automations.approval_editors.add_a_question', 'Add a question')}
                    </button>
                )}
            </div>
        </FormRow>
    );
}
