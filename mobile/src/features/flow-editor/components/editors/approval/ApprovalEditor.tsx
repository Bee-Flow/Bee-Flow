/**
 * The approval step — the web's ApprovalFields (approvalEditors.jsx): what
 * the approver is asked and shown, then who decides and by when. The
 * question is a template because an approver has to SEE what they decide on
 * (`{{steps.x.output.y}}` resolves before it is read); a reject ends the run.
 *
 * One round (a person, a panel, a final sign-off, an escalation) and a chain
 * of stages supersede one another — validate.js refuses the combination — so
 * switching is a mode change that carries over what the other shape can say.
 * The approver directory is read once; a failed read leaves the owner only.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { readableExample } from '@/features/flow-editor/components/outline/readableText';
import { useApprovalDirectory } from '@/features/flow-editor/hooks';

import { ApprovalClocks } from './ApprovalClocks';
import { ApprovalDocuments } from './ApprovalDocuments';
import { oneRoundFrom, stagesFrom, type Question, type Stage } from './approvalModel';
import { ApprovalQuestions } from './ApprovalQuestions';
import { ApprovalRound } from './ApprovalRound';
import { ApprovalStages } from './ApprovalStages';
import { upstreamFieldOptions } from '../route/fieldOptions';
import { Band } from '../shared/Band';
import { listOf } from '../shared/list';
import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';

/** The examples in the empty boxes: templates, not copy — shown as their pills read ("‹Trigger ▸ Client›"). */
const PROMPT_EXAMPLE = 'Send the {{steps.quote.output.total}} quote to {{trigger.output.client}}?';
const DETAILS_EXAMPLE = '**Client:** {{trigger.output.client}}\n**Total:** {{steps.quote.output.total}}';

export function ApprovalEditor(editor: StepEditorProps) {
    const t = useTranslation();
    const { draft, set, setMany, ctx } = editor;
    const directory = useApprovalDirectory().data ?? null;
    const stages = listOf<Stage>(draft.stages);
    const chained = stages.length > 0;
    const panel = Array.isArray(draft.approvers) && draft.approvers.length > 0;
    const disabled = ctx.disabled;
    return (
        <>
            <Band editor={editor} sectionKey="config" title={t('mobile.flow.approval.what', 'What to approve')} defaultOpen>
                <Note>{t('mobile.flow.approval.intro', 'The run stops here until someone decides. Approve and it continues from the next step. Reject and the run ends — nothing after this step runs.')}</Note>
                <BindingInput
                    mode="template"
                    multiline
                    required
                    label={t('mobile.flow.approval.question', 'Question for the approver')}
                    hint={t('mobile.flow.approval.question_hint', 'What the person is asked. Tap Insert data to pull in values from earlier steps, so they can see what they are deciding on.')}
                    value={typeof draft.prompt === 'string' ? draft.prompt : ''}
                    onChange={(v) => set('prompt', String(v))}
                    prompt={readableExample(PROMPT_EXAMPLE)}
                    disabled={disabled}
                    testID="approval-prompt"
                />
                <BindingInput
                    mode="template"
                    multiline
                    label={t('mobile.flow.approval.more_info', 'More information')}
                    hint={t('mobile.flow.approval.more_info_hint', 'Shown under the question. Give the approver the context they need — amounts, recipients, the drafted text. Markdown works.')}
                    value={typeof draft.details === 'string' ? draft.details : ''}
                    onChange={(v) => set('details', String(v))}
                    prompt={readableExample(DETAILS_EXAMPLE)}
                    disabled={disabled}
                />
                <ApprovalDocuments rows={listOf(draft.attachments)} onChange={(next) => set('attachments', next)} disabled={disabled} />
                <ApprovalQuestions questions={listOf<Question>(draft.approvalFields)} onChange={(next) => set('approvalFields', next)} disabled={disabled} />
            </Band>
            <Band editor={editor} sectionKey="waiting" title={t('mobile.flow.approval.deadline', 'Deadline')} defaultOpen>
                {chained ? (
                    <ApprovalStages
                        stages={stages}
                        onChange={(next) => set('stages', next)}
                        onDropStages={() => setMany(oneRoundFrom(draft))}
                        shared={{ directory, sampleRoot: ctx.sampleRoot, fieldOptions: upstreamFieldOptions(ctx.groups), disabled }}
                    />
                ) : (
                    <ApprovalRound
                        draft={draft}
                        setMany={setMany}
                        directory={directory}
                        disabled={disabled}
                        onUseStages={() => setMany(stagesFrom(draft, t('routines.builder.approval_final_stage_name', 'Final sign-off')))}
                    />
                )}
                <ApprovalClocks draft={draft} setMany={setMany} directory={directory} disabled={disabled} escalation={!chained && !panel} />
            </Band>
        </>
    );
}
