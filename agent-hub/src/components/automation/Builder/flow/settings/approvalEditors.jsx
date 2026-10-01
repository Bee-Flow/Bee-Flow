// The approval step editor, extracted verbatim from SettingsForm.jsx.
import { Plus, Trash2, Workflow, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import ConditionBuilder from '../../mapping/ConditionBuilder';
import ComposeField from '../../valueSlot/ComposeField';
import AccordionSection from '../AccordionSection';
import { ApprovalStagesEditor, DirectoryOptions } from './approvalStages';
import { slugifyFieldName } from './FormBuilderFields';
import { actionButtonClass, controlSurfaceClass, FormRow, hintTextClass } from './formPrimitives';
import { STAGE_RULES, stageSeats, newStageKey } from './formState';

/**
 * How long an approval may sit before the run is closed as expired.
 *
 * Offered as choices rather than a number box because "how long should a person
 * have?" is a business decision with a handful of sensible answers, not an
 * arithmetic one — and because the two ends of the range are the ones that
 * matter: a same-day gate, and no deadline at all. `0` is a real value here,
 * not an empty one: the engine reads it as "never expire".
 *
 * The bound (720h / 30 days) mirrors the engine's own ceiling, so a choice
 * offered here is always a choice the run will honour.
 */
const APPROVAL_DEADLINE_CHOICES = [
    { value: 4, label: '4 hours' },
    { value: 24, label: '1 day' },
    { value: 72, label: '3 days' },
    { value: 168, label: '7 days' },
    { value: 336, label: '14 days' },
    { value: 720, label: '30 days' },
    { value: 0, label: 'No deadline' },
];

// Reminder / escalation delays — shorter horizons than the deadline list, and
// no zero: both clocks are opt-in ('' = off), unlike the deadline.
const APPROVAL_CLOCK_CHOICES = [
    { value: 1, label: '1 hour' },
    { value: 4, label: '4 hours' },
    { value: 24, label: '1 day' },
    { value: 48, label: '2 days' },
    { value: 72, label: '3 days' },
    { value: 168, label: '7 days' },
];

/** The stored `{ value, label }` choices as the comma-separated line we show. */
const joinChoices = (options) => (Array.isArray(options) ? options : [])
    .map(o => (o?.label ?? o?.value ?? o))
    .filter(Boolean)
    .join(', ');

/** The reverse: what the author typed, back as the `{ value, label }` pairs. */
const splitChoices = (text) => text.split(',').map(x => x.trim()).filter(Boolean);

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
export function ApprovalChoicesInput({ options, onChange }) {
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
            placeholder="Choices, comma-separated"
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
function storedQuestionName(question) {
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
 * can carry the routine with it (`onRenameField`, which rewrites every ref,
 * template and expression in the same edit); this editor has no such callback,
 * and an editable name that silently breaks bindings is the very bug above
 * wearing a different hat. The name is SHOWN instead, so the author can see
 * what to bind.
 */
export function approvalQuestionName(question, index, questions = []) {
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

/**
 * The approval editor: one question, one deadline.
 *
 * The question is a ComposeField rather than a plain input because the whole
 * point of an approval is that someone can see what they are deciding on — an
 * approver reading "Approve?" has to go and find the invoice themselves, which
 * is how approvals become rubber stamps. The engine interpolates this string
 * against the paused run, so {{steps.x.output.y}} resolves before it is read.
 */
function ApprovalFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }) {
    const api = useAutomationApi();
    const { t } = useTranslation();
    const hours = Number.isFinite(Number(draft.expiresInHours)) ? Number(draft.expiresInHours) : 168;
    const choices = APPROVAL_DEADLINE_CHOICES.some(c => c.value === hours)
        ? APPROVAL_DEADLINE_CHOICES
        : [...APPROVAL_DEADLINE_CHOICES, { value: hours, label: `${hours} hours` }];

    // The org directory feeds the approver picker. Loaded lazily and cached
    // for the editor's lifetime; a failed load degrades to owner-only rather
    // than blocking the section.
    const [directory, setDirectory] = useState(null);
    useEffect(() => {
        let alive = true;
        api.approvalDirectory()
            .then(d => { if (alive) setDirectory(d || { members: [], groups: [] }); })
            .catch(() => { if (alive) setDirectory({ members: [], groups: [] }); });
        return () => { alive = false; };
    }, [api]);

    // One <select> encodes the three assignee states: '' (owner), 'u:<id>',
    // 'g:<id>' — decoded back into the persisted { userId } | { groupId }.
    const assigneeValue = draft.assignee?.userId ? `u:${draft.assignee.userId}`
        : (draft.assignee?.groupId ? `g:${draft.assignee.groupId}` : '');
    const onAssignee = (e) => {
        const v = e.target.value;
        if (!v) return set('assignee', null);
        const [kind, id] = [v.slice(0, 1), v.slice(2)];
        set('assignee', kind === 'u' ? { userId: id } : { groupId: id });
    };

    // Panel mode: seats live in draft.approvers; a null entry is a seat the
    // author has not picked yet (buildPatch drops it). Removing every seat
    // returns to the single-approver select.
    const panelSeats = Array.isArray(draft.approvers) ? draft.approvers : [];
    const panelActive = panelSeats.length > 0;
    const realSeatCount = panelSeats.filter(seat => seat && (seat.userId || seat.groupId)).length;
    const setSeat = (i, encoded) => {
        const next = panelSeats.map((seat, idx) => {
            if (idx !== i) return seat;
            if (!encoded) return null;
            return encoded.slice(0, 1) === 'u' ? { userId: encoded.slice(2) } : { groupId: encoded.slice(2) };
        });
        set('approvers', next);
    };

    // ── Stage mode ────────────────────────────────────────────────────
    // Stages and the legacy fields (assignee / panel / final sign-off /
    // escalation) SUPERSEDE one another: validate.js errors on the
    // combination (approval.stages_conflict) rather than silently never ask
    // someone who believes they are in the chain. So this is a MODE SWITCH,
    // not a second section — turning stages on clears the legacy fields, and
    // turning them off clears the chain.
    const stages = Array.isArray(draft.stages) ? draft.stages : [];
    const stagesActive = stages.length > 0;

    const useStages = () => {
        const picked = panelSeats.filter(seat => seat && (seat.userId || seat.groupId));
        const first = picked.length ? picked : (draft.assignee ? [draft.assignee] : []);
        const rule = picked.length >= 2 && STAGE_RULES.includes(draft.rule) ? draft.rule : 'all';
        const chain = [{
            // A fresh chain, so `newStageKey` simply yields s1 — but it is
            // the ONLY minting path, and it never re-uses a key in play.
            key: newStageKey([]),
            name: '',
            description: '',
            // A stage with no seat yet still opens with one empty row to pick in.
            approvers: first.length ? first : [null],
            rule: picked.length >= 2 ? rule : 'all',
            ...(picked.length >= 2 && rule === 'quorum' ? { quorum: Number(draft.quorum) || 2 } : {}),
        }];
        const finalSeat = draft.finalApprover;
        if (finalSeat?.userId || finalSeat?.groupId) {
            chain.push({
                key: newStageKey(chain),
                name: t('routines.builder.approval_final_stage_name', 'Final sign-off'),
                description: '',
                approvers: [finalSeat],
                rule: 'first',
            });
        }
        // Seed first, THEN clear — nothing the author already picked is lost.
        set('stages', chain);
        set('assignee', null);
        set('approvers', []);
        set('finalApprover', null);
        set('escalateTo', null);
        set('escalateAfterHours', '');
    };

    const dropStages = () => {
        // Carry back everything the simple shape can still express: the first
        // stage becomes the approver(s), and a single-seat last stage becomes
        // the final sign-off. The stages in between have nowhere to go, which
        // is what the button's copy says.
        const first = stages[0] || null;
        const firstSeats = stageSeats(first);
        const last = stages.length > 1 ? stages[stages.length - 1] : null;
        const lastSeats = stageSeats(last);
        set('stages', []);
        if (firstSeats.length > 1) {
            set('approvers', firstSeats);
            set('assignee', null);
            set('rule', STAGE_RULES.includes(first?.rule) ? first.rule : 'all');
            if (first?.rule === 'quorum') set('quorum', Math.min(Math.max(Number(first.quorum) || 2, 1), firstSeats.length));
        } else {
            set('approvers', []);
            set('assignee', firstSeats[0] || null);
        }
        set('finalApprover', lastSeats.length === 1 ? lastSeats[0] : null);
    };

    const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
    const setAttachment = (i, patchRow) => {
        const next = attachments.map((row, idx) => (idx === i ? { ...row, ...patchRow } : row));
        set('attachments', next);
    };
    const questions = Array.isArray(draft.approvalFields) ? draft.approvalFields : [];
    const setQuestion = (i, patchRow) => {
        const next = questions.map((row, idx) => (idx === i ? { ...row, ...patchRow } : row));
        set('approvalFields', next);
    };

    return (
        <>
            <AccordionSection stepType="approval" sectionKey="config" title="What to approve" defaultOpen forceOpen={errorSections.has('config')}>
                <p className="mb-2 text-xs text-[var(--text-tertiary)]">
                    The run stops here until someone decides. Approve and it continues from the next
                    step. Reject and the run ends — nothing after this step runs.
                </p>
                <FormRow
                    label="Question for the approver"
                    required
                    hint="What the person is asked. Drop in values from earlier steps, so they can see what they are deciding on."
                >
                    <ComposeField stepType="approval" field="prompt"
                        value={draft.prompt || ''}
                        onChange={(next) => set('prompt', next)}
                        rows={3}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="Send the {{steps.quote.output.total}} quote to {{trigger.output.client}}?"
                    />
                </FormRow>
                <FormRow
                    label="More information"
                    hint="Shown under the question. Give the approver the context they need — amounts, recipients, the drafted text. Markdown works."
                >
                    <ComposeField stepType="approval" field="approval.details"
                        value={draft.details || ''}
                        onChange={(next) => set('details', next)}
                        rows={4}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={'**Client:** {{trigger.output.client}}\n**Total:** {{steps.quote.output.total}}'}
                        listAs="markdown"
                    />
                </FormRow>
                <FormRow
                    label="Documents to show"
                    hint="Files earlier steps produced (a generated PDF or Word document) that the approver can download before deciding. Up to 5."
                >
                    <div className="space-y-1.5">
                        {attachments.map((att, i) => (
                            <div key={i} className="flex items-start gap-1.5">
                                <div className="flex-1 min-w-0">
                                    <ComposeField stepType="approval" field="approval.attachments" slotKey={String(i)}
                                        value={att.binding || ''}
                                        onChange={(next) => setAttachment(i, { binding: next })}
                                        rows={1}
                                        onFocusField={onFocusField}
                                        previewSample={previewSample}
                                        placeholder="{{steps.doc.output.fileId}}"
                                    />
                                </div>
                                <input
                                    type="text"
                                    value={att.label || ''}
                                    onChange={(e) => setAttachment(i, { label: e.target.value })}
                                    placeholder="Shown name (optional)"
                                    className={controlSurfaceClass('w-40 shrink-0 px-2 py-1.5 text-sm')}
                                />
                                <button
                                    type="button"
                                    aria-label="Remove document"
                                    onClick={() => set('attachments', attachments.filter((_, idx) => idx !== i))}
                                    className="p-1.5 text-[var(--text-tertiary)] hover:text-red-500 transition"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))}
                        {attachments.length < 5 && (
                            <button
                                type="button"
                                onClick={() => set('attachments', [...attachments, { binding: '', label: '' }])}
                                className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                            >
                                <Plus size={12} /> Add a document
                            </button>
                        )}
                    </div>
                </FormRow>
                <FormRow
                    label="Questions for the approver"
                    hint="Extra answers collected with the decision — later steps can use them as this step's output.answers. Up to 20."
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
                                    placeholder="Question label"
                                    className={controlSurfaceClass('flex-1 min-w-[8rem] px-2 py-1.5 text-sm')}
                                />
                                <select
                                    value={q.type || 'text'}
                                    onChange={(e) => setQuestion(i, { type: e.target.value })}
                                    aria-label="Answer type"
                                    className={controlSurfaceClass('w-auto shrink-0 px-2 py-1.5 text-sm')}
                                >
                                    <option value="text">Short text</option>
                                    <option value="textarea">Long text</option>
                                    <option value="number">Number</option>
                                    <option value="date">Date</option>
                                    <option value="select">Choice</option>
                                    <option value="checkbox">Yes/no</option>
                                    <option value="email">Email</option>
                                </select>
                                <label className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                                    <input
                                        type="checkbox"
                                        checked={!!q.required}
                                        onChange={(e) => setQuestion(i, { required: e.target.checked })}
                                        className="h-3.5 w-3.5"
                                    />
                                    required
                                </label>
                                <button
                                    type="button"
                                    aria-label="Remove question"
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
                                    could carry the routine's references with it — but an
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
                                    Later steps read this answer as{' '}
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
                                <Plus size={12} /> Add a question
                            </button>
                        )}
                    </div>
                </FormRow>
            </AccordionSection>
            <AccordionSection stepType="approval" sectionKey="waiting" title="Deadline" defaultOpen forceOpen={errorSections.has('waiting')}>
                {stagesActive && (
                    <ApprovalStagesEditor
                        stages={stages}
                        set={set}
                        directory={directory}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        onDropStages={dropStages}
                        t={t}
                    />
                )}
                {!stagesActive && !panelActive && (
                    <FormRow
                        label="Who decides"
                        hint="A person or group in your organisation. They get the notification; the first decision wins. Leave empty and you decide."
                    >
                        <div className="flex items-center gap-2">
                            <select
                                value={assigneeValue}
                                onChange={onAssignee}
                                className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                                aria-label="Who decides"
                            >
                                <option value="">Me (the owner)</option>
                                <DirectoryOptions directory={directory} />
                            </select>
                            <button
                                type="button"
                                onClick={() => {
                                    // Seed the panel with the current approver so switching
                                    // modes never silently discards a choice.
                                    set('approvers', draft.assignee ? [draft.assignee, null] : [null]);
                                    set('assignee', null);
                                }}
                                className="shrink-0 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                            >
                                + More approvers
                            </button>
                        </div>
                    </FormRow>
                )}
                {!stagesActive && panelActive && (
                    <FormRow
                        label="Approvers"
                        hint="Up to 10 seats — a person, or a group whose first voting member fills the seat. How the votes resolve is set below. Remove every seat to go back to a single approver."
                    >
                        <div className="space-y-1.5">
                            {panelSeats.map((seat, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <select
                                        value={seat?.userId ? `u:${seat.userId}` : (seat?.groupId ? `g:${seat.groupId}` : '')}
                                        onChange={(e) => setSeat(i, e.target.value)}
                                        className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                                        aria-label={`Approver seat ${i + 1}`}
                                    >
                                        <option value="">— pick a person or group —</option>
                                        <DirectoryOptions directory={directory} />
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => set('approvers', panelSeats.filter((_, idx) => idx !== i))}
                                        aria-label={`Remove approver seat ${i + 1}`}
                                        className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-600 transition"
                                    >
                                        <X size={13} />
                                    </button>
                                </div>
                            ))}
                            {panelSeats.length < 10 && (
                                <button
                                    type="button"
                                    onClick={() => set('approvers', [...panelSeats, null])}
                                    className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                                >
                                    + Add approver
                                </button>
                            )}
                        </div>
                    </FormRow>
                )}
                {!stagesActive && panelActive && realSeatCount >= 2 && (
                    <FormRow
                        label="Decision rule"
                        hint="How the votes become one answer. With “everyone”, one reject declines immediately — the requester hears fast."
                    >
                        <div className="flex items-center gap-2">
                            <select
                                value={draft.rule || 'all'}
                                onChange={(e) => set('rule', e.target.value)}
                                className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                                aria-label="Decision rule"
                            >
                                <option value="all">Everyone must approve</option>
                                <option value="first">First to respond decides</option>
                                <option value="quorum">At least N approvals</option>
                            </select>
                            {(draft.rule || 'all') === 'quorum' && (
                                <select
                                    value={String(Math.min(Math.max(Number(draft.quorum) || 2, 1), realSeatCount))}
                                    onChange={(e) => set('quorum', Number(e.target.value))}
                                    className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                                    aria-label="Approvals needed"
                                >
                                    {Array.from({ length: realSeatCount }, (_, i) => i + 1).map(n => (
                                        <option key={n} value={String(n)}>{`${n} of ${realSeatCount}`}</option>
                                    ))}
                                </select>
                            )}
                        </div>
                    </FormRow>
                )}
                {!stagesActive && (
                    <FormRow
                        label="Final sign-off"
                        hint="Optional second stage: once the approver(s) say yes, this person or group has the last word — only then does the run continue."
                    >
                        <select
                            value={draft.finalApprover?.userId ? `u:${draft.finalApprover.userId}` : (draft.finalApprover?.groupId ? `g:${draft.finalApprover.groupId}` : '')}
                            onChange={(e) => {
                                const v = e.target.value;
                                if (!v) return set('finalApprover', null);
                                set('finalApprover', v.slice(0, 1) === 'u' ? { userId: v.slice(2) } : { groupId: v.slice(2) });
                            }}
                            className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                            aria-label="Final sign-off"
                        >
                            <option value="">No final sign-off</option>
                            <DirectoryOptions directory={directory} />
                        </select>
                    </FormRow>
                )}
                {!stagesActive && (
                    <div className="rounded-md border border-[var(--border-subtle)] px-2 py-1.5 flex items-start justify-between gap-2">
                        <p className={`${hintTextClass()} min-w-0`}>
                            {t('routines.builder.approval_stages_intro', 'Need more than two rounds? Ask several groups in turn — each stage has its own approvers, its own rule and its own name.')}
                        </p>
                        <button
                            type="button"
                            onClick={useStages}
                            className={`${actionButtonClass()} shrink-0`}
                        >
                            <Workflow size={12} /> {t('routines.builder.approval_use_stages', 'Use approval stages')}
                        </button>
                    </div>
                )}
                <FormRow
                    label="Decide within"
                    hint={'If nobody decides in time, the run is closed as expired. Pick "No deadline" to let it wait as long as it needs.'}
                >
                    <select
                        value={String(hours)}
                        onChange={(e) => set('expiresInHours', Number(e.target.value))}
                        className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                        aria-label="Approval deadline"
                    >
                        {choices.map(c => (
                            <option key={c.value} value={String(c.value)}>{c.label}</option>
                        ))}
                    </select>
                </FormRow>
                <FormRow
                    label="Remind after"
                    hint="Nudge the approver again if nobody has decided by then. Must be earlier than the deadline."
                >
                    <select
                        value={String(draft.remindAfterHours || '')}
                        onChange={(e) => set('remindAfterHours', e.target.value ? Number(e.target.value) : '')}
                        className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                        aria-label="Reminder delay"
                    >
                        <option value="">No reminder</option>
                        {APPROVAL_CLOCK_CHOICES.map(c => (
                            <option key={c.value} value={String(c.value)}>{c.label}</option>
                        ))}
                    </select>
                </FormRow>
                {!stagesActive && !panelActive && (
                <FormRow
                    label="Escalate to"
                    hint="If nobody decides, this person or group ALSO gains the right to decide — the original approver keeps theirs."
                >
                    <div className="flex items-center gap-2">
                        <select
                            value={draft.escalateTo?.userId ? `u:${draft.escalateTo.userId}` : (draft.escalateTo?.groupId ? `g:${draft.escalateTo.groupId}` : '')}
                            onChange={(e) => {
                                const v = e.target.value;
                                if (!v) { set('escalateTo', null); set('escalateAfterHours', ''); return; }
                                set('escalateTo', v.slice(0, 1) === 'u' ? { userId: v.slice(2) } : { groupId: v.slice(2) });
                                if (!draft.escalateAfterHours) set('escalateAfterHours', 24);
                            }}
                            className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                            aria-label="Escalate to"
                        >
                            <option value="">No escalation</option>
                            {(directory?.members || []).map(m => (
                                <option key={m.id} value={`u:${m.id}`}>{m.name}</option>
                            ))}
                            {(directory?.groups || []).length > 0 && (
                                <optgroup label="Groups">
                                    {(directory?.groups || []).map(g => (
                                        <option key={g.id} value={`g:${g.id}`}>{g.name}</option>
                                    ))}
                                </optgroup>
                            )}
                        </select>
                        {(draft.escalateTo?.userId || draft.escalateTo?.groupId) && (
                            <select
                                value={String(draft.escalateAfterHours || 24)}
                                onChange={(e) => set('escalateAfterHours', Number(e.target.value))}
                                className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                                aria-label="Escalation delay"
                            >
                                {APPROVAL_CLOCK_CHOICES.map(c => (
                                    <option key={c.value} value={String(c.value)}>{`after ${c.label}`}</option>
                                ))}
                            </select>
                        )}
                    </div>
                </FormRow>
                )}
            </AccordionSection>
        </>
    );
}

export { ApprovalFields };
