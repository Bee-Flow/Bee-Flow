import { ArrowLeft, Clock, Download, ExternalLink, FileText, User } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import ApprovalDecisionControls, { type ApprovalField } from './ApprovalDecisionControls';
import { approvalSourceInfo, approvalStatusChip, formatWhen, stageChainInfo } from './approvalDisplay';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import useTranslation from '../../../../hooks/useTranslation';
import { FormRichText } from '../../../forms/PublicFormRenderer';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import type { ApprovalListRow } from './useApprovals';
import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { ApprovalVote, ApprovalStage, PanelProgressData, ApprovalProgress, ApprovalAttachment, ApprovalRecord, ApprovalDetailData, ApprovalDecisionResponse, ApprovalApi, ApprovalDetailProps, StatusLabelProps, PanelProgressProps, BackButtonProps } from './ApprovalDetail.types';
import { waitingStageLine, auditLine, formatSize } from './ApprovalDetail.helpers';
import { Section, StageTimeline } from './StageTimeline';

export default function ApprovalDetail({ approvalId, onBack, onDecided }: ApprovalDetailProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const api = useAutomationApi() as ApprovalApi;
    const [data, setData] = useState<ApprovalDetailData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setData(null);
        setError(null);
        api.getApproval(approvalId)
            .then(d => { if (alive) setData(d); })
            .catch(e => { if (alive) setError(e.message || t('studio_misc.errors.load_approval', 'Could not load this approval')); });
        return () => { alive = false; };
    }, [api, approvalId, t]);

    if (error) {
        return (
            <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">
                <BackButton onBack={onBack} />
                <div className="mt-6 text-sm text-red-600 dark:text-red-400">{error}</div>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">
                <BackButton onBack={onBack} />
                <div className="mt-6 text-sm text-[var(--text-tertiary)]">{t('approvals.loading', 'Loading…')}</div>
            </div>
        );
    }

    const { approval, audit, runLink, canDecide, canWithdraw, votes, progress } = data;
    const sourceInfo = approvalSourceInfo(approval, t);
    const chain = stageChainInfo(approval);

    const withdraw = async () => {
        if (!(await confirm({ title: t('approvals.withdraw_confirm', 'Withdraw this approval request? Whoever was asked will be told, and a paused run is closed.'), confirmLabel: t('approvals.withdraw', 'Withdraw this request'), destructive: true }))) return;
        try {
            const res = await api.withdrawApproval(approval.id);
            toast.success(t('approvals.toast_withdrawn', 'Request withdrawn.'));
            const fresh = res.approval || { ...approval, status: 'cancelled' };
            setData(d => ({ ...d, approval: fresh, canDecide: false, canWithdraw: false }));
            onDecided?.(fresh);
        } catch (e) {
            const msg = (e as Error)?.message || 'unknown error';
            if (/409|already/i.test(msg)) toast.error(t('approvals.toast_already', 'This approval was already decided.'));
            else toast.error(`Couldn't withdraw: ${msg}`);
            api.getApproval(approval.id).then(setData).catch(() => {});
        }
    };

    const decide = async (decision: string, reason: string | undefined, answers: unknown) => {
        try {
            const res = await api.decideApproval(approval.id, decision, reason, answers);
            // A panel that has not resolved yet records a VOTE: the row stays
            // pending, the progress updates, and nothing downstream fires.
            if (res.decision === 'vote_recorded') {
                // A staged row reports WHICH stage is now waiting when the
                // chain advanced (`stage` is only set on an advance), so the
                // person who just voted hears that their stage closed rather
                // than "waiting for the other approvers" — there are none.
                const staged = res.progress?.kind === 'stages';
                const nextStage = staged && res.stage
                    ? (res.progress.stages || []).find(s => s.key === res.stage)
                    : null;
                if (staged && nextStage && res.progress.position) {
                    toast.success(t('approvals.toast_stage_passed', 'This stage is done — it has moved on to {name} (stage {n} of {m}).', {
                        name: nextStage.name || t('approvals.stage_unnamed', 'this stage'),
                        n: String(res.progress.position.index),
                        m: String(res.progress.position.total),
                    }));
                } else {
                    toast.success(res.stage === 'final'
                        ? t('approvals.toast_panel_final', 'The panel approved — waiting for the final sign-off.')
                        : t('approvals.toast_vote', 'Your vote is in — waiting for the other approvers.'));
                }
                api.getApproval(approval.id).then(setData).catch(() => {});
                return;
            }
            toast.success(decision === 'approve' ? t('approvals.toast_approved', 'Approved — the run is continuing.') : t('approvals.toast_rejected', 'Rejected — the run has stopped.'));
            const fresh = res.approval || { ...approval, status: decision === 'approve' ? 'approved' : 'rejected' };
            setData(d => ({ ...d, approval: fresh, canDecide: false }));
            onDecided?.(fresh);
        } catch (e) {
            const msg = (e as Error)?.message || 'unknown error';
            if (/410|expired/i.test(msg)) toast.error(t('approvals.toast_expired', 'The deadline for this approval has passed and the run was closed.'));
            else if (/409|already/i.test(msg)) toast.error(t('approvals.toast_race', 'Someone else already decided this approval.'));
            else toast.error(`Couldn't ${decision}: ${msg}`);
            // Whatever happened, the row we shows may be stale — refresh it.
            api.getApproval(approval.id).then(setData).catch(() => {});
        }
    };

    return (
        <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <BackButton onBack={onBack} />
                <StatusLabel status={approval.status} t={t} />
            </div>

            {/* The question, given the room a question deserves. What used to
                be a bordered card inside a bordered card is now just the page:
                an eyebrow saying which automation asked, the ask itself as the
                heading, and the facts that qualify it on one quiet line. */}
            <div className="mt-6">
                <div className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                    {sourceInfo ? (
                        <a
                            href={sourceInfo.href}
                            className="hover:underline"
                            onClick={(e) => {
                                e.preventDefault();
                                window.history.pushState({}, '', sourceInfo.href);
                                window.dispatchEvent(new PopStateEvent('popstate'));
                            }}
                        >
                            {sourceInfo.label}
                        </a>
                    ) : (approval.automationTitle || t('approvals.automation', 'Automation'))}
                </div>
                <h1
                    className="mt-1.5 text-[var(--text-primary)] whitespace-pre-wrap break-words [font-size:clamp(19px,3vw,24px)]! [font-weight:600] [letter-spacing:-0.02em] [line-height:1.3]"
                >
                    {approval.prompt || t('approvals.untitled', 'Approval requested')}
                </h1>
                <div className="mt-3 flex items-center gap-x-4 gap-y-1 flex-wrap text-[12px] text-[var(--text-tertiary)]">
                    <span className="inline-flex items-center gap-1.5"><User size={12} />
                        {chain
                            ? t('approvals.chain_of', 'Chain of {n} stages', { n: String(chain.total) })
                            : Array.isArray(approval.approvers) && approval.approvers.length
                            ? t('approvals.panel_of', 'Panel of {n}').replace('{n}', String(approval.approvers.length))
                            : (approval.assigneeUserId || approval.assigneeGroupId
                                ? (approval.assigneeGroupId ? t('approvals.assigned_group', 'Assigned to a group') : t('approvals.assigned', 'Assigned'))
                                : t('approvals.owner_decides', 'Owner decides'))}
                    </span>
                    <span className="inline-flex items-center gap-1.5"><Clock size={12} />
                        {approval.status === 'pending'
                            ? (approval.expiresAt ? `${t('approvals.decide_before_cap', 'Decide before')} ${formatWhen(approval.expiresAt)}` : t('approvals.no_deadline', 'No deadline'))
                            : `${t('approvals.requested', 'Requested')} ${formatWhen(approval.createdAt)}`}
                    </span>
                    {runLink && (
                        <a
                            href={runLink}
                            className="inline-flex items-center gap-1.5 text-[var(--accent-primary,#2563eb)] hover:underline"
                            onClick={(e) => {
                                e.preventDefault();
                                window.history.pushState({}, '', runLink);
                                window.dispatchEvent(new PopStateEvent('popstate'));
                            }}
                        >
                            <ExternalLink size={12} /> {t('approvals.open_run', 'Open the run')}
                        </a>
                    )}
                </div>
            </div>

            {/* The snapshot, as prose rather than as a grey slab. Nothing is
                dropped — FormRichText renders the same markdown it always
                did, tables included. */}
            {approval.detailsMd && (
                <Section>
                    <div className="text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                        <FormRichText>{approval.detailsMd}</FormRichText>
                    </div>
                </Section>
            )}

            {Array.isArray(approval.attachments) && approval.attachments.length > 0 && (
                <Section label={t('approvals.documents', 'Documents')}>
                    <div className="-mx-2">
                        {approval.attachments.map(att => (
                            <a
                                key={att.fileId}
                                href={api.approvalFileUrl(approval.id, att.fileId)}
                                className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-[var(--bg-secondary)] transition text-[13px] text-[var(--text-primary)]"
                            >
                                <FileText size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                                <span className="flex-1 min-w-0 truncate">{att.label || att.filename}</span>
                                <span className="text-[11px] text-[var(--text-tertiary)]">{formatSize(att.size)}</span>
                                <Download size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                            </a>
                        ))}
                    </div>
                </Section>
            )}

            {/* Two shapes come back on `progress`, and they are not
                interchangeable: a staged row carries the whole chain
                (kind: 'stages'), a panel row carries one tally and no
                `kind` at all. Branch on it so the panel rendering that
                predates stages keeps working byte for byte. */}
            {progress && (progress.kind === 'stages'
                ? <StageTimeline progress={progress} approval={approval} t={t} />
                : <PanelProgress progress={progress} votes={votes} approval={approval} t={t} />)}

            <Section>
                {approval.status === 'pending' ? (
                    <>
                        {canDecide ? (
                            <ApprovalDecisionControls fields={approval.fields} onDecide={decide} />
                        ) : (
                            <div className="text-[12.5px] text-[var(--text-tertiary)]">
                                {progress && progress.kind === 'stages'
                                    ? waitingStageLine(progress, t)
                                    : progress
                                    ? (progress.stage === 'final'
                                        ? t('approvals.waiting_final', 'Waiting for the final sign-off.')
                                        : t('approvals.waiting_panel', 'Waiting for the other approvers to vote.'))
                                    : (approval.assigneeGroupId
                                        ? t('approvals.waiting_group', 'Waiting for the assigned group to decide.')
                                        : t('approvals.waiting_assignee', 'Waiting for the assigned approver to decide.'))}
                            </div>
                        )}
                        {canWithdraw && (
                            <div className="pt-3">
                                <button
                                    type="button"
                                    onClick={withdraw}
                                    className="text-[12px] text-[var(--text-tertiary)] underline underline-offset-2 hover:text-[var(--text-primary)] transition"
                                >
                                    {t('approvals.withdraw', 'Withdraw this request')}
                                </button>
                            </div>
                        )}
                    </>
                ) : (
                    <DecisionSummary approval={approval} />
                )}
            </Section>

            {Array.isArray(audit) && audit.length > 0 && (
                <Section label={t('approvals.history', 'History')}>
                    <ol className="space-y-1">
                        {audit.map((ev) => (
                            <li key={ev.id} className="text-[12px] text-[var(--text-secondary)] flex items-baseline gap-2.5">
                                <span className="text-[var(--text-tertiary)] tabular-nums shrink-0">{formatWhen(ev.ts)}</span>
                                <span>{auditLine(ev, t)}</span>
                            </li>
                        ))}
                    </ol>
                </Section>
            )}
            {confirmDialog}
        </div>
    );
}

function StatusLabel({ status, t }: StatusLabelProps) {
    const chip = approvalStatusChip(status);
    return (
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${chip.textCls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${chip.dotCls}`} aria-hidden="true" />
            {t(`approvals.status_${status}`, chip.label)}
        </span>
    );
}

function PanelProgress({ progress, votes, approval, t }: PanelProgressProps) {
    const ruleLabel = progress.rule === 'first'
        ? t('approvals.rule_first', 'First to respond decides')
        : (progress.rule === 'quorum'
            ? t('approvals.rule_quorum', 'At least {n} of {m} must approve').replace('{n}', String(progress.needed)).replace('{m}', String(progress.seatCount))
            : t('approvals.rule_all', 'Everyone must approve'));
    return (
        <Section
            label={`${t('approvals.panel', 'Approval panel')} · ${ruleLabel}`}
            aside={approval.status === 'pending' ? (
                <span className="text-[12px] text-[var(--text-secondary)]">
                    {progress.stage === 'final'
                        ? t('approvals.stage_final', 'Panel approved — final sign-off pending')
                        : `${progress.approvals}/${progress.needed} ${t('approvals.approved_so_far', 'approved')}`}
                </span>
            ) : null}
        >
            {Array.isArray(votes) && votes.length > 0 && (
                <ul className="space-y-1">
                    {votes.map((v, i) => (
                        <li key={i} className="text-[12.5px] text-[var(--text-secondary)] flex items-baseline gap-1.5">
                            <span className={v.decision === 'approve' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                                {v.decision === 'approve' ? '✓' : '✕'}
                            </span>
                            <span className="font-medium text-[var(--text-primary)]">{v.name || v.by}</span>
                            {v.stage === 'final' && <span className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('approvals.final_badge', 'final')}</span>}
                            {v.reason && <span className="truncate">— “{v.reason}”</span>}
                        </li>
                    ))}
                </ul>
            )}
            {progress.hasFinalStage && approval.status === 'pending' && progress.stage !== 'final' && (
                <div className="mt-1.5 text-[11.5px] text-[var(--text-tertiary)]">
                    {t('approvals.final_after', 'A final sign-off follows once the panel approves.')}
                </div>
            )}
        </Section>
    );
}

function BackButton({ onBack }: BackButtonProps) {
    const { t } = useTranslation();
    if (!onBack) return <span />;
    return (
        <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
        >
            <ArrowLeft size={14} /> {t('approvals.all', 'All approvals')}
        </button>
    );
}

function DecisionSummary({ approval }: { approval: ApprovalRecord }) {
    const { t } = useTranslation();
    const verbs: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired', cancelled: 'Closed' };
    const verb = verbs[approval.status ?? '']
        ? t(`approvals.verb_${approval.status}`, verbs[approval.status ?? ''])
        : approval.status;
    return (
        <div className="text-[13px] text-[var(--text-primary)] space-y-1">
            <div>
                <span className="font-medium">{verb}</span>
                {approval.decidedByName ? ` ${t('approvals.by', 'by')} ${approval.decidedByName}` : ''}
                {approval.decidedAt ? ` · ${formatWhen(approval.decidedAt)}` : ''}
            </div>
            {approval.decisionReason && <div className="text-[var(--text-secondary)]">“{approval.decisionReason}”</div>}
            {approval.answers && Object.keys(approval.answers).length > 0 && (
                <div className="pt-1 space-y-0.5">
                    {Object.entries(approval.answers).map(([k, v]) => (
                        <div key={k} className="text-[12px]">
                            <span className="text-[var(--text-tertiary)]">{k}:</span>{' '}
                            <span>{typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

