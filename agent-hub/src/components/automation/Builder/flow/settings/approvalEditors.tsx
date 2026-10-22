// The approval step editor, extracted verbatim from SettingsForm.jsx.
import { useTranslation } from '../../../../../hooks/useTranslation';
import TemplateField from '../../mapping/TemplateField';
import AccordionSection from '../AccordionSection';
import { ApprovalClockFields } from './approvalClocks';
import { ApprovalDocumentsField } from './approvalDocuments';
import { ApprovalQuestionsField } from './approvalQuestions';
import { ApprovalStagesEditor } from './approvalStages';
import { dropStages, startStages, useApprovalDirectory } from './approvalState';
import { ApprovalWhoFields } from './approvalWho';
import { FormRow } from './formPrimitives';
import type { SetDraft } from './approvalTypes';
import type { FormRecord } from './formState/types';
import type { OnFocusField } from '../../mapping/focusField.types';

export { ApprovalChoicesInput, approvalQuestionName } from './approvalQuestions';

/**
 * The approval editor: one question, one deadline.
 *
 * The question is a TemplateField rather than a plain input because the whole
 * point of an approval is that someone can see what they are deciding on — an
 * approver reading "Approve?" has to go and find the invoice themselves, which
 * is how approvals become rubber stamps. The engine interpolates this string
 * against the paused run, so {{steps.x.output.y}} resolves before it is read.
 */
interface ApprovalFieldsProps {
    draft: FormRecord;
    set: SetDraft;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
}

function ApprovalFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }: ApprovalFieldsProps) {
    const { t } = useTranslation();
    const directory = useApprovalDirectory();

    // Panel mode: seats live in draft.approvers; a null entry is a seat the
    // author has not picked yet (buildPatch drops it). Removing every seat
    // returns to the single-approver select.
    const panelSeats = Array.isArray(draft.approvers) ? draft.approvers : [];
    const panelActive = panelSeats.length > 0;

    // Stage mode is a MODE SWITCH, not a second section (see startStages).
    const stages = Array.isArray(draft.stages) ? draft.stages : [];
    const stagesActive = stages.length > 0;

    return (
        <>
            <AccordionSection stepType="approval" sectionKey="config" title={t('automations.approval_editors.what_to_approve', 'What to approve')} defaultOpen forceOpen={errorSections.has('config')}>
                <p className="mb-2 text-xs text-[var(--text-tertiary)]">
                    {t('automations.approval_editors.the_run_stops_here_until_someone', 'The run stops here until someone decides. Approve and it continues from the next step. Reject and the run ends — nothing after this step runs.')}
                </p>
                <FormRow
                    label={t('automations.approval_editors.question_for_the_approver', 'Question for the approver')}
                    required
                    hint={t('automations.approval_editors.what_the_person_is_asked_use', 'What the person is asked. Use {{ }} to pull in values from earlier steps, so they can see what they are deciding on.')}
                >
                    <TemplateField
                        value={draft.prompt || ''}
                        onChange={(next) => set('prompt', next)}
                        rows={3}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={t('automations.approval_editors.send_the_quote_to', 'Send the {{steps.quote.output.total}} quote to {{trigger.output.client}}?')}
                    />
                </FormRow>
                <FormRow
                    label={t('automations.approval_editors.more_information', 'More information')}
                    hint={t('automations.approval_editors.shown_under_the_question_give_the', 'Shown under the question. Give the approver the context they need — amounts, recipients, the drafted text. Markdown works.')}
                >
                    <TemplateField
                        value={draft.details || ''}
                        onChange={(next) => set('details', next)}
                        rows={4}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={'**Client:** {{trigger.output.client}}\n**Total:** {{steps.quote.output.total}}'}
                        listAs="markdown"
                    />
                </FormRow>
                <ApprovalDocumentsField
                    attachments={Array.isArray(draft.attachments) ? draft.attachments : []}
                    set={set}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
                <ApprovalQuestionsField questions={Array.isArray(draft.approvalFields) ? draft.approvalFields : []} set={set} />
            </AccordionSection>
            <AccordionSection stepType="approval" sectionKey="waiting" title={t('automations.approval_editors.deadline', 'Deadline')} defaultOpen forceOpen={errorSections.has('waiting')}>
                {stagesActive && (
                    <ApprovalStagesEditor
                        stages={stages}
                        set={set}
                        directory={directory}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        onDropStages={() => dropStages(stages, set)}
                        t={t}
                    />
                )}
                {!stagesActive && (
                    <ApprovalWhoFields
                        draft={draft}
                        set={set}
                        directory={directory}
                        panelSeats={panelSeats}
                        panelActive={panelActive}
                        onUseStages={() => startStages(draft, panelSeats, set, t)}
                    />
                )}
                <ApprovalClockFields draft={draft} set={set} directory={directory} showEscalation={!stagesActive && !panelActive} />
            </AccordionSection>
        </>
    );
}

export { ApprovalFields };
