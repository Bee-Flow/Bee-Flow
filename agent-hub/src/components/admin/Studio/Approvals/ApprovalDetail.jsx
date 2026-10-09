import { ArrowLeft, Check, Circle, CircleDashed, Clock, Download, ExternalLink, FileText, SkipForward, User } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import ApprovalDecisionControls from './ApprovalDecisionControls';
import { approvalSourceInfo, approvalStatusChip, formatWhen, stageChainInfo } from './approvalDisplay';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import useTranslation from '../../../../hooks/useTranslation';
import { FormRichText } from '../../../forms/PublicFormRenderer';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';

/**
 * The approval, as the person deciding it needs to see it: the question, the
 * snapshotted context (details / attachments / extra questions), the deadline,
 * and the decision controls — with the audit strip underneath so "who asked,
 * who decided, when" is always one glance away.
 *
 * Everything renders from the SNAPSHOT on the approval row. Nothing here
 * re-derives from the run: the approver judges what the run showed at pause
 * time, and the record keeps meaning the same thing years later.
 */
export default function ApprovalDetail({ approvalId, onBack, onDecided }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const api = useAutomationApi();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

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
            const msg = e?.message || 'unknown error';
            if (/409|already/i.test(msg)) toast.error(t('approvals.toast_already', 'This approval was already decided.'));
            else toast.error(`Couldn't withdraw: ${msg}`);
            api.getApproval(approval.id).then(setData).catch(() => {});
        }
    };

    const decide = async (decision, reason, answers) => {
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
            const msg = e?.message || 'unknown error';
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
                    className="mt-1.5 text-[var(--text-primary)] whitespace-pre-wrap break-words"
                    style={{ fontSize: 'clamp(19px, 3vw, 24px)', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.3 }}
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
                        {audit.map(ev => (
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

/**
 * A block of the approval, separated from the one above it by a hairline
 * rather than wrapped in its own card. The old detail nested three levels of
 * border — page card → progress box → stage row — which is what made a short
 * approval read as a dense form. One rule between sections carries the same
 * "these belong apart" without any of the weight.
 */
function Section({ label, aside, children }) {
    return (
        <section className="mt-6 pt-6 border-t border-[var(--border-subtle)]">
            {(label || aside) && (
                <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2.5">
                    {label ? <h2 className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">{label}</h2> : <span />}
                    {aside}
                </div>
            )}
            {children}
        </section>
    );
}

/** Status as a coloured dot and a word — see approvalStatusChip. */
function StatusLabel({ status, t }) {
    const chip = approvalStatusChip(status);
    return (
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${chip.textCls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${chip.dotCls}`} aria-hidden="true" />
            {t(`approvals.status_${status}`, chip.label)}
        </span>
    );
}

/**
 * The panel at a glance: the rule, how far the votes have got, each vote as
 * its own line, and — in the second stage — who holds the final word. Renders
 * from the server's progress/votes payload only, so this view and the vote
 * engine cannot disagree about the arithmetic.
 */
function PanelProgress({ progress, votes, approval, t }) {
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

/** The stage a staged, still-pending row is sitting on. */
function waitingStageLine(progress, t) {
    const stages = Array.isArray(progress.stages) ? progress.stages : [];
    const current = stages.find(s => s.key === progress.stage) || null;
    const pos = progress.position;
    if (!current || !pos) return t('approvals.waiting_chain', 'Waiting for an earlier stage of this approval.');
    return t('approvals.waiting_stage', 'Waiting for {name} — stage {n} of {m}.', {
        name: current.name || t('approvals.stage_unnamed', 'this stage'),
        n: String(pos.index),
        m: String(pos.total),
    });
}

/**
 * The chain, as a vertical stepper.
 *
 * Every stage the approval was created with is shown — including the ones it
 * will never reach and the ones its conditions ruled out. "Why did this never
 * get to finance?" is an audit question, and a stage that quietly vanished
 * from the timeline cannot answer it. So the five states each get their own
 * marker and their own sentence:
 *
 *   done          decided, and the chain moved past it
 *   current       the people being asked right now
 *   waiting       still to come
 *   skipped       its condition was not met — deliberately passed over
 *   never_reached the chain stopped (declined / expired / withdrawn) first
 *
 * Rendered from the server's payload only, so this view and the vote engine
 * cannot disagree about the arithmetic.
 */
function StageTimeline({ progress, approval, t }) {
    const stages = Array.isArray(progress.stages) ? progress.stages : [];
    if (!stages.length) return null;
    // "Stage 2 of 3" counts the stages that actually run, exactly as the
    // server's stagePosition does — a skipped stage was never a step anybody
    // waited on, so numbering it would describe a chain that never existed.
    const activeTotal = progress.position?.total ?? stages.filter(s => s.state !== 'skipped').length;
    const positions = stages.reduce((acc, stage) => {
        const seen = acc.seen + (stage.state === 'skipped' ? 0 : 1);
        return { seen, list: [...acc.list, stage.state === 'skipped' ? null : { index: seen, total: activeTotal }] };
    }, { seen: 0, list: [] }).list;
    return (
        <Section
            label={t('approvals.stages_title', 'Approval chain')}
            aside={approval.status === 'pending' && progress.position ? (
                <span className="text-[12px] text-[var(--text-secondary)]">
                    {t('approvals.stage_of', 'Stage {n} of {m}', {
                        n: String(progress.position.index), m: String(progress.position.total),
                    })}
                </span>
            ) : null}
        >
            <ol className="space-y-0">
                {stages.map((stage, i) => (
                    <StageStep
                        key={stage.key || i}
                        stage={stage}
                        position={positions[i]}
                        last={i === stages.length - 1}
                        t={t}
                    />
                ))}
            </ol>
        </Section>
    );
}

/**
 * One stage. The marker column carries a connector line so the chain reads as
 * one sequence rather than five cards; the line stops being solid once the
 * chain does, which is what makes `never_reached` legible at a glance.
 */
function StageStep({ stage, position, last, t }) {
    const state = stage.state;
    const done = state === 'done';
    const current = state === 'current';
    const skipped = state === 'skipped';
    const stopped = state === 'never_reached';

    const marker = done
        ? <Check size={11} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        : current
            ? <Circle size={11} className="text-amber-600 dark:text-amber-400 fill-current" aria-hidden="true" />
            : skipped
                ? <SkipForward size={11} className="text-[var(--text-tertiary)]" aria-hidden="true" />
                : <CircleDashed size={11} className="text-[var(--text-tertiary)]" aria-hidden="true" />;

    const ruleLabel = stage.rule === 'first'
        ? t('approvals.rule_first', 'First to respond decides')
        : (stage.rule === 'quorum'
            ? t('approvals.rule_quorum', 'At least {n} of {m} must approve')
                .replace('{n}', String(stage.needed)).replace('{m}', String(stage.seatCount))
            : t('approvals.rule_all', 'Everyone must approve'));

    const stateLine = done
        ? t('approvals.stage_state_done', 'Decided')
        : current
            ? t('approvals.stage_state_current', 'Waiting on this stage')
            : skipped
                ? t('approvals.stage_state_skipped', 'Skipped — its condition was not met, so the chain went straight past it')
                : stopped
                    ? t('approvals.stage_state_never_reached', 'Never reached — the chain stopped before this stage')
                    : t('approvals.stage_state_waiting', 'Not started yet');

    const votes = Array.isArray(stage.votes) ? stage.votes : [];
    const muted = skipped || stopped;

    return (
        <li className="flex gap-2">
            <div className="flex flex-col items-center shrink-0 pt-0.5">
                <span
                    className={`inline-flex items-center justify-center w-4 h-4 rounded-full border ${
                        done ? 'border-emerald-500/50 bg-emerald-500/10'
                            : current ? 'border-amber-500/60 bg-amber-500/15'
                                : 'border-[var(--border-default)] bg-[var(--bg-secondary)]'
                    }`}
                >
                    {marker}
                </span>
                {!last && (
                    <span
                        className={`w-px flex-1 min-h-[1.25rem] ${done ? 'bg-emerald-500/40' : 'bg-[var(--border-default)]'} ${muted ? 'opacity-50' : ''}`}
                        aria-hidden="true"
                    />
                )}
            </div>
            <div className={`min-w-0 flex-1 pb-2 ${muted ? 'opacity-70' : ''}`}>
                <div className="flex items-baseline gap-1.5 flex-wrap">
                    <span className={`text-[13px] ${current ? 'font-semibold' : 'font-medium'} text-[var(--text-primary)] ${skipped ? 'line-through decoration-[var(--text-tertiary)]' : ''}`}>
                        {stage.name || t('approvals.stage_unnamed', 'this stage')}
                    </span>
                    {position && (
                        <span className="text-[11px] text-[var(--text-secondary)]">
                            {t('approvals.stage_of', 'Stage {n} of {m}', { n: String(position.index), m: String(position.total) })}
                        </span>
                    )}
                </div>
                {stage.description && (
                    <div className="text-[12px] text-[var(--text-secondary)]">{stage.description}</div>
                )}
                <div className="text-[11px] text-[var(--text-secondary)]">
                    {stateLine}
                    {!skipped && !stopped && ` · ${ruleLabel}`}
                    {(done || current) && !skipped && ` · ${t('approvals.stage_tally', '{n} of {m} approved', {
                        n: String(stage.approvals), m: String(stage.needed),
                    })}`}
                    {stage.rejects > 0 && ` · ${t('approvals.stage_declined_here', 'declined here')}`}
                </div>
                {votes.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                        {votes.map((v, i) => (
                            <li key={i} className="text-[12px] text-[var(--text-secondary)] flex items-baseline gap-1.5">
                                <span className={v.decision === 'approve' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                                    {v.decision === 'approve' ? '✓' : '✕'}
                                </span>
                                <span className="font-medium text-[var(--text-primary)]">{v.name || v.by}</span>
                                {v.reason && <span className="truncate">— “{v.reason}”</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </li>
    );
}

function BackButton({ onBack }) {
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

function DecisionSummary({ approval }) {
    const { t } = useTranslation();
    const verbs = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired', cancelled: 'Closed' };
    const verb = verbs[approval.status]
        ? t(`approvals.verb_${approval.status}`, verbs[approval.status])
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

function auditLine(ev, t) {
    switch (ev.decision) {
        case 'requested': return ev.source === 'backfill'
            ? t('approvals.audit_recorded', 'Approval recorded')
            : t('approvals.audit_requested', 'Approval requested');
        case 'approved': return `${t('approvals.verb_approved', 'Approved')}${ev.comment ? ` — “${ev.comment}”` : ''}`;
        case 'rejected': return `${t('approvals.verb_rejected', 'Rejected')} — “${ev.comment || ''}”`;
        // The chain moving from one stage to the next. The comment carries
        // "<stage that passed> → <stage now waiting>", which is the whole
        // sentence — an audit trail that only said "Stage passed" would leave
        // the reader counting stages by hand.
        case 'stage_passed': return `${t('approvals.audit_stage_passed', 'Stage passed')}${ev.comment ? ` — ${ev.comment}` : ''}`;
        case 'expired': return t('approvals.audit_expired', 'Expired — nobody decided before the deadline');
        case 'escalated': return t('approvals.audit_escalated', 'Escalated — the fallback approver can now decide too');
        case 'hook_ran': return `${t('approvals.audit_hook_ran', 'App updated')}${ev.comment ? ` — ${ev.comment}` : ''}`;
        case 'hook_failed': return `${t('approvals.audit_hook_failed', 'App update failed')}${ev.comment ? ` — ${ev.comment}` : ''}`;
        case 'cancelled': return ev.decidedBy
            ? `${t('approvals.audit_withdrawn', 'Withdrawn')}${ev.comment ? ` — “${ev.comment}”` : ''}`
            : t('approvals.audit_closed', 'Closed — the run was no longer waiting');
        default: return ev.decision;
    }
}

function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
