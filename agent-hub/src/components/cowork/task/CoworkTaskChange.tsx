import { useState } from 'react';
import type { PlanDraft, PlanParameter } from '@/api/coworkPlan.types';
import { recipientWord } from './coworkTaskSendsModel';
import CoworkProposalDetails from '../CoworkProposalDetails';
import { BTN_QUIET, FIELD, Failure, META, ROW_ACTIONS } from './taskUi';
import type { SettingRowId } from './coworkTaskSettingsModel';
import { useCoworkProposalActions, useCoworkProposals } from '@/api/coworkProposals';
import type { TranslateFn } from '@/hooks/useTranslation';

export default function CoworkTaskChange({ coworkId, approved, draft, live, onSetting, t }: {
    coworkId: string; approved: boolean; draft?: PlanDraft | null; live: boolean; onSetting: (row: SettingRowId) => void; t: TranslateFn;
}) {
    const [instruction, setInstruction] = useState('');
    const [parameter, setParameter] = useState<PlanParameter | null>(null);
    const fields = draft?.parameters ?? [];
    const label = (p: PlanParameter) => (draft?.view.steps.find((s) => s.id === p.stepId)?.title ?? p.stepId) + ' · ' + ({
        query: t('cowork_task.param.query', 'Search filter'), folder: t('cowork_task.param.folder', 'Folder'),
        path: t('cowork_task.param.path', 'File path'), subject: t('cowork_task.param.subject', 'Subject'),
        to: t('cowork_task.param.to', 'Recipient'),
    })[p.field];
    const proposals = useCoworkProposals(coworkId);
    const { requestChange, approve, dismiss } = useCoworkProposalActions(coworkId);
    const proposal = proposals.data?.find((p) => p.reasonCode === 'owner_request' && p.status === 'open');
    const busy = live || requestChange.isPending || approve.isPending || dismiss.isPending;
    return <details className="py-2">
        <summary className="cursor-pointer font-medium">{t('cowork_task.edit.task', 'Adjust this task')}</summary>
        <div className="mt-3 flex flex-col gap-3">
            <div className={ROW_ACTIONS}>
                <button className={BTN_QUIET} onClick={() => onSetting('when')}>{t('cowork_task.edit.when', 'When')}</button>
                <button className={BTN_QUIET} onClick={() => onSetting('uses')}>{t('cowork_task.set.uses', 'Uses')}</button>
                <button className={BTN_QUIET} onClick={() => onSetting('sends')}>{t('cowork_task.set.sends', 'Sends to')}</button>
            </div>
            {proposal ? <>
                <p className={META}>{t('cowork_task.edit.passed', 'The proposed steps passed their test. Review the changes before approving.')}</p>
                {!!proposal.recipients?.length && <p>{t('cowork_task.set.sends', 'Sends to')} · {proposal.recipients.map((to) => recipientWord(to, t)).join(', ')}</p>}
                {proposal.parameterChanges?.map((p) => <p className="break-words" key={JSON.stringify([p.stepId, p.field])}>{label(p)} · {p.before} → {p.value}</p>)}
                <CoworkProposalDetails proposal={proposal} t={t} />
                <div className={ROW_ACTIONS}>
                    <button className={BTN_QUIET} disabled={busy} onClick={() => approve.mutate({ proposalId: proposal.id, fingerprint: proposal.fingerprint })}>{t('cowork_task.tested.approve', 'Approve')}</button>
                    <button className={BTN_QUIET} disabled={busy} onClick={() => dismiss.mutate(proposal.id)}>{t('cowork_task.edit.discard', 'Discard proposal')}</button>
                </div>
            </> : approved ? <form className="flex flex-col items-start gap-2" onSubmit={(e) => {
                e.preventDefault();
                if (!busy && instruction.trim()) requestChange.mutate(parameter
                    ? { parameter: { ...parameter, before: parameter.value, value: instruction.trim() } }
                    : { instruction: instruction.trim() }, { onSuccess: () => { setInstruction(''); setParameter(null); } });
            }}>
                {fields.length > 0 && <label>{t('cowork_task.param.choose', 'What do you want to change?')}
                    <select className={FIELD} value={parameter ? fields.findIndex((p) => p.field === parameter.field && p.stepId === parameter.stepId) : -1}
                        onChange={(e) => { const next = fields[Number(e.target.value)] ?? null; setParameter(next); setInstruction(next?.value ?? ''); }}>
                        <option value={-1}>{t('cowork_task.param.describe', 'Describe a change')}</option>
                        {fields.map((p, i) => <option key={JSON.stringify([p.stepId, p.field])} value={i}>{label(p)}</option>)}
                    </select>
                </label>}
                <label className="w-full">{parameter ? label(parameter) : t('cowork_task.edit.request', 'What should the steps do differently?')}
                    <textarea className={FIELD} value={instruction} maxLength={2000} onChange={(e) => setInstruction(e.target.value)} /></label>
                <button className={BTN_QUIET} disabled={busy || !instruction.trim()}>{requestChange.isPending ? t('cowork_task.edit.testing', 'Testing the change…') : t('cowork_task.edit.propose', 'Prepare and test a proposal')}</button>
            </form> : <button className={BTN_QUIET} onClick={() => onSetting('what')}>{t('cowork_task.set.what', 'What')}</button>}
            <Failure error={requestChange.error || approve.error || dismiss.error || proposals.error} t={t} />
        </div>
    </details>;
}
