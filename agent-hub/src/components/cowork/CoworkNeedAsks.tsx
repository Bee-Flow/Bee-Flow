/**
 * The cards of ./CoworkNeedCard.tsx that carry what a run prepared and that wait for the owner's yes:
 *
 *   send     a step waits for the owner's OK before something is sent (an approval of the plan's automation, read
 *            and answered over the approvals API, ../../api/coworkApprovals.ts): Send / Don't send. Once sent, when
 *            that recipient has earned it, one more question: always allow it from now on, or keep asking
 *            (PUT /api/cowork/:id/plan/trust). Without the approval to hand (no licence for it, already decided) it
 *            says so and opens Approvals;
 *   review   the agent asks its owner to look at something: Approve (it goes on) or ask for changes with a note;
 *   repair   Cowork worked out a fix for steps that kept failing: what changes, then Approve the fix or Not now.
 */
import { useEffect, useState } from 'react';
import { NeedBox, NeedFrame, useNeedAct, type NeedKindProps } from './CoworkNeedFrame';
import CoworkProposalDetails from './CoworkProposalDetails';
import { repairLine } from './coworkProposalModel';
import { LINK_BUTTON, PILL_PRIMARY, PILL_QUIET } from './coworkUi';
import { resolveCoworkReview } from '@/api/coworkApi';
import { useDecideApproval, usePendingApproval, type PendingApproval } from '@/api/coworkApprovals';
import { useCoworkTrust } from '@/api/coworkIndependence';
import { useCoworkProposalActions, useCoworkProposals } from '@/api/coworkProposals';
import { useTranslation } from '@/hooks/useTranslation';

const APPROVALS_LINK = '/app/studio/approvals';

/** After a message went out: "always allow this recipient?", when the task earned it; otherwise it just settles. */
function TrustQuestion({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const { query, choose } = useCoworkTrust(need.itemId);
    const offer = query.data?.entries.find((e) => e.canTrust && !e.trusted && e.recipient !== '*');
    const settled = query.isError || (query.isSuccess && !offer);
    const { isIdle, mutate } = act;
    // Nothing to offer: the message went, and the card goes with the next read.
    useEffect(() => {
        if (settled && isIdle) mutate({ run: async () => null, done: t('cowork_home.done.sent', 'Sent.') });
    }, [settled, isIdle, mutate, t]);
    if (!offer) return null;
    const to = offer.recipient;
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: () => choose.mutateAsync({ stepId: offer.stepId, recipient: to, trusted: true }), done: t('cowork_home.done.trusted', 'From now on it sends to {to} without asking.', { to }) })}>
                {t('cowork_home.need.always_allow', 'Always allow')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: async () => null, done: t('cowork_home.done.keeps_asking', 'Sent. It keeps asking before it sends to {to}.', { to }) })}>
                {t('cowork_home.need.keep_asking', 'Keep asking')}
            </button>
        </>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error}
            title={t('cowork_home.need.sent_to', 'Sent to {to}', { to })}
            sub={t('cowork_home.need.trust_sub', 'Always allow this task to send to {to} from now on?', { to })}
        />
    );
}

function SendQuestion({ props, approval }: { props: NeedKindProps; approval: PendingApproval }) {
    const { t } = useTranslation();
    const decide = useDecideApproval();
    const act = useNeedAct(props.onDone);
    const [sent, setSent] = useState(false);
    if (sent) return <TrustQuestion {...props} />;
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: async () => { await decide.mutateAsync({ id: approval.id, decision: 'approve' }); setSent(true); }, settle: false })}>
                {t('cowork_home.need.send', 'Send')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: () => decide.mutateAsync({ id: approval.id, decision: 'reject' }), done: t('cowork_home.done.not_sent', 'Not sent.') })}>
                {t('cowork_home.need.dont_send', 'Don’t send')}
            </button>
        </>
    );
    return (
        <NeedFrame
            {...props} actions={actions} error={act.error}
            title={approval.prompt || t('cowork_home.need.send_title', 'A message waits for you')}
            sub={t('cowork_home.need.send_sub', 'Nothing is sent until you say so.')}
            extra={approval.detailsMd ? <NeedBox testId="cowork-need-message">{approval.detailsMd}</NeedBox> : null}
        />
    );
}

/** A step waits for the owner's OK before it sends: the message, Send or Don't send. */
export function SendCard(props: NeedKindProps) {
    const { t } = useTranslation();
    const pending = usePendingApproval(props.need.automationId);
    if (pending.data) return <SendQuestion props={props} approval={pending.data} />;
    const actions = (
        <>
            <a className={PILL_PRIMARY} href={APPROVALS_LINK}>{t('cowork_home.need.to_approvals', 'Open in Approvals')}</a>
            <button type="button" className={PILL_QUIET} onClick={() => props.onOpenTask(props.need.itemId)}>{t('cowork_home.need.open_task', 'Open the task')}</button>
        </>
    );
    return <NeedFrame {...props} title={t('cowork_home.need.send_title', 'A message waits for you')} sub={t('cowork_home.need.send_sub', 'Nothing is sent until you say so.')} actions={actions} />;
}

/** The agent asks its owner to look at something: approve it and it goes on, or say what should change. */
export function ReviewCard(props: NeedKindProps) {
    const { need, onDone } = props;
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const [asking, setAsking] = useState(false);
    const [note, setNote] = useState('');
    const runId = need.runId ?? '';
    const answer = (text: string, done: string) => act.mutate({ run: () => resolveCoworkReview(need.itemId, runId, { action: 'answer', answer: text }), done });
    const fieldId = `cowork-need-note-${need.key}`;
    const actions = asking ? (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending || !note.trim()} onClick={() => answer(note.trim(), t('cowork_home.done.redo', 'Sent. It works your note in.'))}>
                {t('cowork_home.need.send_note', 'Send note and redo')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => setAsking(false)}>{t('cowork_home.need.cancel', 'Cancel')}</button>
        </>
    ) : (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending || !runId} onClick={() => answer(t('cowork_home.review.approved_answer', 'Approved. Go ahead.'), t('cowork_home.done.approved_result', 'Approved.'))}>
                {t('cowork_home.need.approve', 'Approve')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => setAsking(true)}>{t('cowork_home.need.ask_changes', 'Ask for changes')}</button>
        </>
    );
    const extra = (
        <div className="flex flex-col gap-2">
            {need.reason && <NeedBox testId="cowork-need-reason">{need.reason}</NeedBox>}
            {asking && (
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={fieldId} className="text-[14px] font-semibold text-[var(--text-secondary)]">{t('cowork_home.need.what_change', 'What should change?')}</label>
                    <textarea id={fieldId} value={note} rows={3} maxLength={4000} onChange={(e) => setNote(e.target.value)} placeholder={t('cowork_home.need.note_placeholder', 'Shorter, and put the decision first')} className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-[14px] text-[var(--text-primary)]" />
                </div>
            )}
        </div>
    );
    return <NeedFrame {...props} title={t('cowork_home.need.review', 'The agent asks you to look at something')} sub={t('cowork_home.need.review_sub', 'It goes on only after you answer.')} extra={extra} actions={actions} error={act.error} />;
}

/** A fix Cowork worked out for steps that kept failing: what changes, then approve it or not now. */
export function RepairCard(props: NeedKindProps) {
    const { need, onDone } = props;
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const [open, setOpen] = useState(false);
    const proposal = useCoworkProposals(need.itemId).data?.find((p) => p.id === need.repair?.proposalId);
    const { approve, dismiss } = useCoworkProposalActions(need.itemId);
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending || !proposal} onClick={() => proposal && act.mutate({ run: () => approve.mutateAsync({ proposalId: proposal.id, fingerprint: proposal.fingerprint }), done: t('cowork_home.done.fix_approved', 'Approved. The fix is in the steps now.') })}>
                {t('cowork_home.need.approve_fix', 'Approve the fix')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending || !need.repair} onClick={() => need.repair && act.mutate({ run: () => dismiss.mutateAsync(need.repair?.proposalId ?? ''), done: t('cowork_home.done.snoozed', 'Fine. The task stays on hold; you find the fix in the task.') })}>
                {t('cowork_home.need.not_now', 'Not now')}
            </button>
        </>
    );
    const extra = proposal ? (
        <div className="flex flex-col gap-2">
            <button type="button" className={`${LINK_BUTTON} self-start`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {open ? t('cowork_home.need.hide_changes', 'Hide what changes') : t('cowork_home.need.see_changes', 'See what changes')}
            </button>
            {open && <NeedBox><CoworkProposalDetails proposal={proposal} t={t} /></NeedBox>}
        </div>
    ) : null;
    const line = repairLine({ reasonCode: need.repair?.reasonCode ?? '', stepTitle: need.repair?.stepTitle ?? null }, t);
    return <NeedFrame {...props} title={line} sub={t('cowork_home.need.repair_sub', 'Nothing changes until you approve it.')} extra={extra} actions={actions} error={act.error} />;
}
