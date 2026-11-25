import { useState } from 'react';
import type { PlanDraft, PlanParameter } from '@/api/coworkPlan.types';
import { recipientWord } from './coworkTaskSendsModel';
import CoworkSurface from '../CoworkSurface';
import CoworkActivity from '../CoworkActivity';
import CoworkOrb from '../CoworkOrb';
import CoworkProposalDetails from '../CoworkProposalDetails';
import { BTN_QUIET, FIELD, Failure, META, ROW_ACTIONS } from './taskUi';
import type { SettingRowId } from './coworkTaskSettingsModel';
import { type CoworkProposal, useCoworkProposalActions, useCoworkProposals } from '@/api/coworkProposals';
import type { TranslateFn } from '@/hooks/useTranslation';

function ProposalPreview({ proposal, label, t }: { proposal: CoworkProposal; label: (p: PlanParameter) => string; t: TranslateFn }) {
    return <>
        <p className={META}>{t('cowork_task.edit.passed', 'The proposed steps passed their test. Review the changes before approving.')}</p>
        {!!proposal.recipients?.length && <p>{t('cowork_task.set.sends', 'Sends to')} · {proposal.recipients.map((to) => recipientWord(to, t)).join(', ')}</p>}
        {proposal.parameterChanges?.map((p) => <p className="break-words" key={JSON.stringify([p.stepId, p.field])}>{label(p)} · {p.before} → {p.value}</p>)}
        <CoworkProposalDetails proposal={proposal} t={t} />
    </>;
}

function parameterLabel(p: PlanParameter, draft: PlanDraft | null | undefined, t: TranslateFn) {
    return (draft?.view.steps.find((s) => s.id === p.stepId)?.title ?? p.stepId) + ' · ' + ({
        query: t('cowork_task.param.query', 'Search filter'), folder: t('cowork_task.param.folder', 'Folder'),
        path: t('cowork_task.param.path', 'File path'), subject: t('cowork_task.param.subject', 'Subject'),
        to: t('cowork_task.param.to', 'Recipient'),
    })[p.field];
}

function ParameterPicker({ fields, parameter, label, t, onPick }: {
    fields: PlanParameter[]; parameter: PlanParameter | null; label: (p: PlanParameter) => string;
    t: TranslateFn; onPick: (p: PlanParameter | null) => void;
}) {
    if (!fields.length) return null;
    return <label>{t('cowork_task.param.choose', 'What do you want to change?')}
        <select className={FIELD} value={parameter ? fields.findIndex((p) => p.field === parameter.field && p.stepId === parameter.stepId) : -1}
            onChange={(e) => { const next = fields[Number(e.target.value)] ?? null; onPick(next); }}>
            <option value={-1}>{t('cowork_task.param.describe', 'Describe a change')}</option>
            {fields.map((p, i) => <option key={JSON.stringify([p.stepId, p.field])} value={i}>{label(p)}</option>)}
        </select>
    </label>;
}

function ProposalActivity({ message, preparing }: { message: string; preparing: boolean }) {
    return <CoworkActivity message={message} tone={preparing ? 'thinking' : 'executing'} />;
}

function changeScene(activity: string | null, result: string | null, proposal: CoworkProposal | undefined) {
    if (activity) return activity;
    if (result) return 'done';
    return proposal ? 'review' : 'edit';
}

function proposalActivity(preparing: boolean, applying: boolean, discarding: boolean, t: TranslateFn) {
    if (preparing) return t('cowork_home.activity.proposal', 'Preparing and testing your change…');
    if (applying) return t('cowork_home.activity.applying', 'Applying your change…');
    if (discarding) return t('cowork_home.activity.discarding', 'Discarding the proposal…');
    return null;
}

function resultMessage(open: CoworkProposal | undefined, applied: boolean, discarded: boolean, t: TranslateFn) {
    if (open) return null;
    if (applied) return t('cowork_home.activity.applied', 'Your change has been applied.');
    if (discarded) return t('cowork_home.activity.discarded', 'Proposal discarded.');
    return null;
}

export default function CoworkTaskChange({ coworkId, approved, draft, live, onSetting, t }: {
    coworkId: string; approved: boolean; draft?: PlanDraft | null; live: boolean; onSetting: (row: SettingRowId) => void; t: TranslateFn;
}) {
    const [instruction, setInstruction] = useState('');
    const [parameter, setParameter] = useState<PlanParameter | null>(null);
    const fields = approved ? draft?.parameters ?? [] : [];
    const label = (p: PlanParameter) => parameterLabel(p, draft, t);
    const proposals = useCoworkProposals(coworkId);
    const { requestChange, approve, dismiss } = useCoworkProposalActions(coworkId);
    const proposal = proposals.data?.find((p) => p.reasonCode === 'owner_request' && p.status === 'open');
    const activity = proposalActivity(requestChange.isPending, approve.isPending, dismiss.isPending, t);
    const result = resultMessage(proposal, approve.isSuccess, dismiss.isSuccess, t);
    const scene = changeScene(activity, result, proposal);
    return <details className="peer/change rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3">
        <summary className="cursor-pointer font-medium">{t('cowork_task.edit.task', 'Adjust this task')}</summary>
        <CoworkSurface scene={scene}>
            <div className="mt-3 flex flex-col gap-3">
                {activity ? <ProposalActivity message={activity} preparing={requestChange.isPending} /> : result ? <CoworkActivity message={result} tone="rest">
                    <button className={BTN_QUIET} onClick={() => { approve.reset(); dismiss.reset(); }}>{t('cowork_task.edit.task', 'Adjust this task')}</button>
                </CoworkActivity> : <>
                    {proposal ? <>
                        <CoworkOrb tone="rest" />
                        <ProposalPreview proposal={proposal} label={label} t={t} />
                        <div className={ROW_ACTIONS}>
                            <button className={BTN_QUIET} disabled={live} onClick={() => approve.mutate({ proposalId: proposal.id, fingerprint: proposal.fingerprint })}>{t('cowork_task.tested.approve', 'Approve')}</button>
                            <button className={BTN_QUIET} disabled={live} onClick={() => dismiss.mutate(proposal.id)}>{t('cowork_task.edit.discard', 'Discard proposal')}</button>
                        </div>
                    </> : approved ? <form className="flex flex-col items-start gap-2" onSubmit={(e) => {
                        e.preventDefault();
                        if (!live && instruction.trim()) requestChange.mutate(parameter
                            ? { parameter: { ...parameter, before: parameter.value, value: instruction.trim() } }
                            : { instruction: instruction.trim() }, { onSuccess: () => { setInstruction(''); setParameter(null); } });
                    }}>
                        <label className="w-full">{parameter ? label(parameter) : t('cowork_task.edit.request', 'What should the steps do differently?')}
                            <textarea className={FIELD} value={instruction} maxLength={2000} onChange={(e) => setInstruction(e.target.value)} /></label>
                        <button className={BTN_QUIET} disabled={live || !instruction.trim()}>{t('cowork_task.edit.propose', 'Prepare and test a proposal')}</button>
                    </form> : <button className={BTN_QUIET} onClick={() => onSetting('what')}>{t('cowork_task.set.what', 'What')}</button>}
                </>}
                {scene === 'edit' && <details>
                    <summary className="w-fit cursor-pointer text-[13px] text-[var(--text-secondary)]">{t('cowork_overview.advanced', 'Advanced')}</summary>
                    <div className={ROW_ACTIONS}>
                        <button className={BTN_QUIET} onClick={() => onSetting('when')}>{t('cowork_task.edit.when', 'When')}</button>
                        <button className={BTN_QUIET} onClick={() => onSetting('uses')}>{t('cowork_task.set.uses', 'Uses')}</button>
                        <button className={BTN_QUIET} onClick={() => onSetting('sends')}>{t('cowork_task.set.sends', 'Sends to')}</button>
                    </div>
                        <ParameterPicker fields={fields} parameter={parameter} label={label} t={t} onPick={next => { setParameter(next); setInstruction(next?.value ?? ''); }} />
                </details>}
                <Failure error={requestChange.error || approve.error || dismiss.error || proposals.error} t={t} />
            </div>
        </CoworkSurface>
    </details>;
}
