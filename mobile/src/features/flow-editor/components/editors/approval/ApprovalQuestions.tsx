/**
 * The questions the approver answers with their decision, up to 20 — the
 * web's "Questions for the approver" (approvalEditors.jsx). A question's
 * binding name is minted when its label box is LEFT, once, and printed as
 * STORED: a later step binds what the definition says, not what the next mint
 * would say.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FieldRow, SelectField, ToggleField } from '@/features/flow-editor/components/fields';
import { TextField } from '@/shared/ui';

import { addQuestion, ANSWER_TYPES, approvalQuestionName, joinChoices, MAX_QUESTIONS, splitChoices, storedQuestionName, type Question } from './approvalModel';
import { say } from '../declarative/runtime';
import { AddButton } from '../shared/AddButton';
import { patchAt, removeAt } from '../shared/list';
import { Note } from '../shared/Note';
import { RowCard } from '../shared/RowCard';

/**
 * The choices as one comma-separated line, with its OWN text: a re-join of
 * the trimmed list would swallow the comma the moment it is typed.
 */
function ChoicesInput({ options, onChange, disabled }: { options: unknown; onChange: (next: { value: string; label: string }[]) => void; disabled: boolean }) {
    const t = useTranslation();
    const joined = joinChoices(options);
    const [text, setText] = useState(joined);
    if (splitChoices(text).join(', ') !== splitChoices(joined).join(', ')) setText(joined);
    return (
        <TextField
            value={text}
            onChangeText={(v) => {
                setText(v);
                onChange(splitChoices(v).map((x) => ({ value: x, label: x })));
            }}
            placeholder={t('automations.approval_editors.choices_comma_separated', 'Choices, comma-separated')}
            editable={!disabled}
        />
    );
}

function QuestionRow({ q, i, questions, onChange, disabled }: { q: Question; i: number; questions: Question[]; onChange: (next: Question[]) => void; disabled: boolean }) {
    const t = useTranslation();
    const patch = (p: Partial<Question>) => onChange(patchAt(questions, i, p));
    const name = storedQuestionName(q) || approvalQuestionName(q, i, questions);
    return (
        <RowCard
            title={q.label || t('automations.approval_editors.question_label', 'Question label')}
            onRemove={() => onChange(removeAt(questions, i))}
            removeLabel={t('automations.approval_editors.remove_question', 'Remove question')}
            disabled={disabled}
            testID={`approval-question-${i + 1}`}
        >
            <TextField
                value={q.label || ''}
                onChangeText={(label) => patch({ label })}
                onBlur={() => {
                    const minted = approvalQuestionName(q, i, questions);
                    if (minted !== q.name) patch({ name: minted });
                }}
                placeholder={t('automations.approval_editors.question_label', 'Question label')}
                editable={!disabled}
                testID={`approval-question-${i + 1}-label`}
            />
            <SelectField
                label={t('automations.approval_editors.answer_type', 'Answer type')}
                value={q.type || 'text'}
                options={ANSWER_TYPES.map((o) => ({ value: o.value, label: say(t, o.label) }))}
                onChange={(type) => patch({ type })}
                disabled={disabled}
            />
            {q.type === 'select' ? <ChoicesInput options={q.options} onChange={(options) => patch({ options })} disabled={disabled} /> : null}
            <ToggleField label={t('automations.approval_editors.required', 'required')} value={!!q.required} onChange={(required) => patch({ required })} disabled={disabled} />
            <Note>{t('mobile.flow.approval.reads_answer', 'Later steps read this answer as {path}', { path: `output.answers.${name}` })}</Note>
        </RowCard>
    );
}

export function ApprovalQuestions({ questions, onChange, disabled }: { questions: Question[]; onChange: (next: Question[]) => void; disabled: boolean }) {
    const t = useTranslation();
    return (
        <FieldRow
            label={t('automations.approval_editors.questions_for_the_approver', 'Questions for the approver')}
            hint={t('mobile.flow.approval.questions_hint', "Extra answers collected with the decision — later steps can use them as this step's output.answers. Up to 20.")}
        >
            {questions.map((q, i) => (
                <QuestionRow key={i} q={q} i={i} questions={questions} onChange={onChange} disabled={disabled} />
            ))}
            {questions.length < MAX_QUESTIONS ? <AddButton label={t('automations.approval_editors.add_a_question', 'Add a question')} onPress={() => onChange(addQuestion(questions))} disabled={disabled} testID="approval-question-add" /> : null}
        </FieldRow>
    );
}
