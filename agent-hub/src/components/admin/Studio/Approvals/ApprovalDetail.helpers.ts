import type { StagedProgress, AuditEvent, TFn } from './ApprovalDetail.types';

/** The stage a staged, still-pending row is sitting on. */
export function waitingStageLine(progress: StagedProgress, t: TFn) {
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

export function auditLine(ev: AuditEvent, t: TFn) {
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

export function formatSize(bytes: number | undefined) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
