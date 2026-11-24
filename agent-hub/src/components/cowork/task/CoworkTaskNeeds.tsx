/**
 * What waits for the owner inside an opened task (./CoworkTaskView.tsx), one card per need, ONE adapter: the needs of
 * this task as Needs you lists them (server usecases/coworkNeedsYou.mts) shown through the components that already
 * act on them (the review queue, the repair, Cowork's own wiring fix, the desk invitation), each with one plain
 * sentence and one primary button, plus a way out. Thin on purpose: it is swapped for the shared need card later.
 */
import type { ReactNode } from 'react';
import CoworkRepair from '../CoworkRepair';
import CoworkReviewQueue from '../CoworkReviewQueue';
import CoworkPlanWiringFix from '../CoworkPlanWiringFix';
import { CoworkDeskInvitation } from '../CoworkDeskPanel';
import { approvalsLink } from '../coworkNeedsModel';
import { canApprove } from '../coworkPlanModel';
import { openRepair } from '../coworkProposalModel';
import { BTN_PRIMARY, BTN_QUIET, Failure, ROW_ACTIONS } from './taskUi';
import { useCoworkProposals } from '@/api/coworkProposals';
import { useCoworkPlanActions, useCoworkPlanQuery } from '@/api/queries/coworkPlan';
import { useCoworkItemActions } from '@/api/coworkTask';
import { useItemDesk } from '@/api/coworkDesks';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkNeed } from '@/api/coworkNeedsYou';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

const CONNECTIONS_LINK = '/app/settings/connections';

function NeedCard({ bad = false, title, sub, children, testId }: { bad?: boolean; title: string; sub?: string | null; children?: ReactNode; testId: string }) {
    const tone = bad
        ? 'border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)]'
        : 'border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]';
    return (
        <article className={`rounded-[var(--radius-lg)] border p-4 flex flex-col gap-3 text-[var(--text-primary)] ${tone}`} data-testid={testId}>
            <div className="flex flex-col gap-0.5">
                <div className="text-[16px] font-semibold">{title}</div>
                {sub && <div className="text-[14px] text-[var(--text-secondary)]">{sub}</div>}
            </div>
            {children}
        </article>
    );
}

/** Steps to check, steps that cannot run, or steps that are gone. */
function StepsNeed({ item, need, t }: { item: CoworkItem; need: CoworkNeed; t: TranslateFn }) {
    const state = useCoworkPlanQuery(item.id).data;
    const { approve, remove } = useCoworkPlanActions(item.id);
    const fingerprint = state && canApprove(state) ? state.draft?.fingerprint : undefined;
    const aiInstead = <button type="button" className={BTN_QUIET} disabled={remove.isPending} onClick={() => remove.mutate()}>{t('cowork_task.need.ai_instead', 'Let the AI do it each time')}</button>;
    if (need.plan === 'gone' || need.plan === 'blocked') {
        return (
            <NeedCard bad testId="cowork-task-need-steps" title={need.plan === 'gone' ? t('cowork_task.need.steps_gone', 'The steps behind this task are gone.') : t('cowork_task.need.steps_blocked', 'These steps cannot run as they are.')}
                sub={state?.draft?.findings.map((f) => f.message).join(' ') || null}>
                {state && <CoworkPlanWiringFix coworkId={item.id} state={state} t={t} />}
                <div className={ROW_ACTIONS}>{aiInstead}</div>
                <Failure error={remove.error} t={t} />
            </NeedCard>
        );
    }
    return (
        <NeedCard testId="cowork-task-need-steps" title={need.plan === 'changed' ? t('cowork_task.need.steps_changed', 'The steps changed. Check them before it runs again.') : t('cowork_task.need.steps_first', 'Check the steps before it runs.')}
            sub={t('cowork_task.need.steps_sub', 'Nothing runs until you approve them. Try it first if you like: nothing is changed or sent.')}>
            <div className={ROW_ACTIONS}>
                {fingerprint && <button type="button" className={BTN_PRIMARY} disabled={approve.isPending} onClick={() => approve.mutate(fingerprint)}>{t('cowork_task.need.approve_steps', 'Approve steps')}</button>}
                {aiInstead}
            </div>
            <Failure error={approve.error || remove.error} t={t} />
        </NeedCard>
    );
}

/** A run that did not do its work: run it again, or let the AI do it each time. */
function FailedNeed({ item, need, t }: { item: CoworkItem; need: CoworkNeed; t: TranslateFn }) {
    const { runNow } = useCoworkItemActions(item.id);
    const { remove } = useCoworkPlanActions(item.id);
    const title = need.kind === 'ai_failed' ? t('cowork_task.need.ai_failed', 'The AI says its last run failed.') : t('cowork_task.need.incomplete', 'The last run did not do its work: a step found nothing to work on.');
    return (
        <NeedCard bad testId="cowork-task-need-failed" title={title} sub={need.reason}>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_PRIMARY} disabled={runNow.isPending} onClick={() => runNow.mutate()}>{t('cowork_task.need.run_again', 'Run it again')}</button>
                <button type="button" className={BTN_QUIET} disabled={remove.isPending} onClick={() => remove.mutate()}>{t('cowork_task.need.ai_instead', 'Let the AI do it each time')}</button>
            </div>
            <Failure error={runNow.error || remove.error} t={t} />
        </NeedCard>
    );
}

function OneNeed({ item, need, t }: { item: CoworkItem; need: CoworkNeed; t: TranslateFn }) {
    const repair = openRepair(useCoworkProposals(item.id).data);
    switch (need.kind) {
        case 'review': return <CoworkReviewQueue coworkId={item.id} reloadKey={undefined} />;
        case 'repair': return repair ? <CoworkRepair coworkId={item.id} proposal={repair} /> : null;
        case 'plan': return <StepsNeed item={item} need={need} t={t} />;
        case 'incomplete':
        case 'ai_failed': return <FailedNeed item={item} need={need} t={t} />;
        case 'sign_in':
            return (
                <NeedCard bad testId="cowork-task-need-sign-in" title={t('cowork_task.need.sign_in', 'Sign in to the app again')}
                    sub={t('cowork_task.need.sign_in_sub', 'The sign-in ran out, so it paused itself. Nothing is lost: it picks up from where it stopped.')}>
                    <div className={ROW_ACTIONS}><a className={BTN_PRIMARY} href={CONNECTIONS_LINK}>{t('cowork_task.need.sign_in_go', 'Sign in again')}</a></div>
                </NeedCard>
            );
        default:
            return (
                <NeedCard testId="cowork-task-need-decision" title={t('cowork_task.need.decision', 'A step waits for your OK before it sends.')} sub={t('cowork_task.need.decision_sub', 'Nothing is sent until you say so.')}>
                    <div className={ROW_ACTIONS}><a className={BTN_PRIMARY} href={approvalsLink()}>{t('cowork_task.need.decide', 'Decide now')}</a></div>
                </NeedCard>
            );
    }
}

/** A colleague invited this task to a desk: it would pass its work on, or get theirs. */
function Invitation({ item }: { item: CoworkItem }) {
    const desk = useItemDesk(item.id).data;
    if (!desk || desk.accepted) return null;
    return <div data-testid="cowork-task-need-handoff"><CoworkDeskInvitation coworkId={item.id} title={item.title} desk={desk} /></div>;
}

export default function CoworkTaskNeeds({ item, needs }: { item: CoworkItem; needs: CoworkNeed[] }) {
    const { t } = useTranslation();
    // One review queue holds every run that waits for a check.
    const shown = needs.filter((need, i) => need.kind !== 'review' || needs.findIndex((n) => n.kind === 'review') === i);
    return (
        <div className="flex flex-col gap-3" data-testid="cowork-task-needs">
            {shown.map((need) => <OneNeed key={`${need.kind}-${need.runId ?? need.plan ?? ''}`} item={item} need={need} t={t} />)}
            <Invitation item={item} />
        </div>
    );
}
