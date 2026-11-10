import { Trash2 } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { INPUT_CLS } from '@/components/admin/Studio/AppStudio/inspector/panels/kit';
import { ApprovalChoicesInput, approvalQuestionName } from '@/components/automation/Builder/flow/settings/approvalEditors';
import { canonicalQuestions, MAX_APPROVAL_QUESTIONS, type ApprovalQuestion } from '../stepFieldShapes';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

const typeOptions = (t: TranslateFn) => [
    { value: 'text', label: t('studio_apps_step_fields.questions.type_text', 'Short text') },
    { value: 'textarea', label: t('studio_apps_step_fields.questions.type_textarea', 'Long text') },
    { value: 'number', label: t('studio_apps_step_fields.questions.type_number', 'Number') },
    { value: 'date', label: t('studio_apps_step_fields.questions.type_date', 'Date') },
    { value: 'select', label: t('studio_apps_step_fields.questions.type_select', 'Choice') },
    { value: 'checkbox', label: t('studio_apps_step_fields.questions.type_checkbox', 'Yes / no') },
    { value: 'email', label: t('studio_apps_step_fields.questions.type_email', 'Email') },
];

/**
 * `approvalQuestions`: what the approver answers with the decision. The answers reach the
 * onDecided hook as {{answers.<name>}}. Hidden as "AI-authored" before; now the same rules as the
 * automation approval editor: the binding name is minted once from the label (approvalQuestionName,
 * reused) and never re-derived, so rewording a label cannot cut a template off from its answer.
 * The choices box is that editor's own (ApprovalChoicesInput).
 *
 * `help` and `placeholder` have no box here and survive every edit.
 */
function ApprovalQuestionsControl({ value, onChange, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const questions = canonicalQuestions(value);
    const commit = (next: ApprovalQuestion[]) => onChange(next.length ? canonicalQuestions(next) : undefined);
    const patch = (i: number, p: Partial<ApprovalQuestion>) => commit(questions.map((q, j) => (j === i ? { ...q, ...p } : q)));
    const add = () => {
        const taken = new Set(questions.map((q) => q.name));
        let n = questions.length + 1;
        while (taken.has(`q${n}`)) n += 1;
        commit([...questions, { name: `q${n}`, type: 'text' }]);
    };
    return (
        <FormField
            label={t('studio_apps_step_fields.questions.label', 'Questions for the approver')}
            hint={t('studio_apps_step_fields.questions.hint', 'Answered with the decision. The record update below reads an answer as {{answers.name}}. Up to {max}.', { max: MAX_APPROVAL_QUESTIONS })}
        >
            <div className="flex flex-col gap-2" data-step-control="approvalQuestions">
                {questions.map((q, i) => (
                    <QuestionRow key={i} q={q} index={i} questions={questions} onPatch={(p) => patch(i, p)} onRemove={() => commit(questions.filter((_, j) => j !== i))} disabled={disabled} t={t} />
                ))}
                {questions.length < MAX_APPROVAL_QUESTIONS ? (
                    <button
                        type="button"
                        onClick={add}
                        disabled={disabled}
                        className="self-start rounded border border-dashed border-[var(--border-default)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                    >
                        {t('studio_apps_step_fields.questions.add', 'Add a question')}
                    </button>
                ) : null}
            </div>
        </FormField>
    );
}

interface QuestionRowProps {
    q: ApprovalQuestion;
    index: number;
    questions: ApprovalQuestion[];
    onPatch: (p: Partial<ApprovalQuestion>) => void;
    onRemove: () => void;
    disabled: boolean;
    t: TranslateFn;
}

function QuestionRow({ q, index, questions, onPatch, onRemove, disabled, t }: QuestionRowProps) {
    const n = index + 1;
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2">
            <div className="flex items-center gap-1.5">
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={q.label || ''}
                    onChange={(e) => onPatch({ label: e.target.value })}
                    // Minted when the box is LEFT: minting per keystroke froze the
                    // name on the first letter (see approvalQuestionName).
                    onBlur={() => {
                        const trimmed = (q.label || '').trim();
                        const name = approvalQuestionName({ ...q, label: trimmed }, index, questions);
                        if (name !== q.name || trimmed !== (q.label || '')) onPatch({ name, label: trimmed });
                    }}
                    placeholder={t('studio_apps_step_fields.questions.label_placeholder', 'Question, e.g. Goods received?')}
                    disabled={disabled}
                    aria-label={t('studio_apps_step_fields.questions.label_aria', 'Question {n}', { n })}
                />
                <select
                    className={`${INPUT_CLS} max-w-[8rem]`}
                    value={q.type}
                    onChange={(e) => onPatch({ type: e.target.value })}
                    disabled={disabled}
                    aria-label={t('studio_apps_step_fields.questions.type_aria', 'Answer type of question {n}', { n })}
                >
                    {typeOptions(t).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button
                    type="button"
                    onClick={onRemove}
                    disabled={disabled}
                    aria-label={t('studio_apps_step_fields.questions.remove', 'Remove question {n}', { n })}
                    className="shrink-0 p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]"
                >
                    <Trash2 size={13} />
                </button>
            </div>
            {q.type === 'select' ? <ApprovalChoicesInput options={q.options} onChange={(options) => onPatch({ options })} /> : null}
            <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                <input type="checkbox" checked={q.required === true} onChange={(e) => onPatch({ required: e.target.checked })} disabled={disabled} />
                {t('studio_apps_step_fields.questions.required', 'Required')}
            </label>
            <p className="text-[11px] text-[var(--text-tertiary)]">
                {t('studio_apps_step_fields.questions.read_as', 'The record update reads this answer as')}{' '}
                <code>{`{{answers.${q.name}}}`}</code>
            </p>
        </div>
    );
}

const entry: StepFieldTypeModule = { type: 'approvalQuestions', Control: ApprovalQuestionsControl };
export default entry;
