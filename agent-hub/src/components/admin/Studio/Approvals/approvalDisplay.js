/**
 * Display helpers for the Approvals section — pure, so the list and the
 * detail view cannot disagree about what a status looks like or how a
 * timestamp reads.
 */

import { hrefOf, pipelineTarget } from '../../../shared/managedPart';

export const STATUS_TABS = [
    { key: 'pending', label: 'Waiting' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Declined' },
    { key: 'expired', label: 'Expired' },
    { key: 'cancelled', label: 'Closed' },
];

/**
 * One status, three ways to draw it:
 *   cls     — the filled pill (App Studio's approval list still uses it)
 *   textCls — the label alone, in the status colour
 *   dotCls  — a 6px dot in the status colour
 *
 * The Approvals section itself wears the dot + label: a screen that is ALREADY
 * filtered to "Waiting" does not need five filled pills repeating the word, but
 * the colour still has to be there for the mixed tabs and for the detail
 * header. Same three sources of truth, one switch.
 */
export function approvalStatusChip(status) {
    switch (status) {
        case 'pending':
            return {
                label: 'Waiting',
                cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                textCls: 'text-amber-700 dark:text-amber-400',
                dotCls: 'bg-amber-500',
            };
        case 'approved':
            return {
                label: 'Approved',
                cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                textCls: 'text-emerald-700 dark:text-emerald-400',
                dotCls: 'bg-emerald-500',
            };
        case 'rejected':
            return {
                label: 'Declined',
                cls: 'bg-red-500/15 text-red-700 dark:text-red-300',
                textCls: 'text-red-700 dark:text-red-400',
                dotCls: 'bg-red-500',
            };
        case 'expired':
            return {
                label: 'Expired',
                cls: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
                textCls: 'text-orange-700 dark:text-orange-400',
                dotCls: 'bg-orange-500',
            };
        case 'cancelled':
            return {
                label: 'Closed',
                cls: 'bg-gray-500/15 text-gray-600 dark:text-gray-300',
                textCls: 'text-[var(--text-tertiary)]',
                dotCls: 'bg-gray-400',
            };
        default:
            return {
                label: status || '—',
                cls: 'bg-gray-500/15 text-gray-600 dark:text-gray-300',
                textCls: 'text-[var(--text-tertiary)]',
                dotCls: 'bg-gray-400',
            };
    }
}

/**
 * Where a STAGED approval currently sits in its chain, for the surfaces that
 * only have the row (the list, the in-app approval_list) and not the server's
 * full progress payload.
 *
 * Position is counted over the ACTIVE stages, exactly as the server's
 * stagePosition does: a stage whose condition was not met is kept on the row
 * for the audit trail but is not a step anybody waits on, so counting it
 * would tell an approver they are "stage 3 of 4" of a chain that only ever
 * had three steps.
 *
 * Returns null for every non-staged row, which is what keeps the panel and
 * single-assignee rendering untouched.
 */
export function stageChainInfo(row) {
    const stages = Array.isArray(row?.stages) ? row.stages.filter(Boolean) : [];
    if (!stages.length) return null;
    const active = stages.filter(s => !s.skipped);
    if (!active.length) return null;
    const index = row?.stage ? active.findIndex(s => s.key === row.stage) : -1;
    const current = index >= 0 ? active[index] : null;
    return {
        total: active.length,
        index: index >= 0 ? index + 1 : null,
        name: current?.name || null,
        description: current?.description || null,
    };
}

/**
 * "12 Aug, 14:03" — short for a table cell, unambiguous for an audit line.
 * The year appears once it differs from today's: an audit trail is read
 * quarters later, and "12 Aug" from two years ago is a lie of omission.
 */
export function formatWhen(ts) {
    if (!ts) return '—';
    try {
        const d = new Date(ts);
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return d.toLocaleString(undefined, {
            day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return String(ts).slice(0, 16).replace('T', ' ');
    }
}

/**
 * Where an approval row came from, for the rows that are not a paused automation.
 *
 * A PRD deployment of a Solution asks through the same table as an automation does
 * (`source: 'deployment'`, `automationTitle` = the sentence of the request,
 * `context.solutionId` = the Solution whose pipeline it belongs to). Its label
 * is `approvals.source_deployment`, its text the automationTitle the gate
 * wrote, and its link the Solution pipeline, where the plan and the stage are.
 * Without a `solutionId` on the row (an older request) the link falls back to
 * the Solutions overview rather than to a pipeline it cannot name.
 *
 * Returns null for every other source, which keeps the list's old rendering.
 *
 * @param {object | null | undefined} row  an approval row (rowToApproval)
 * @param {(key: string, fallback: string) => string} t
 * @returns {null | { source: 'deployment', label: string, text: string, target: string, href: string }}
 */
export function approvalSourceInfo(row, t) {
    if (row?.source !== 'deployment') return null;
    const solutionId = typeof row.context?.solutionId === 'string' ? row.context.solutionId : null;
    const target = solutionId ? pipelineTarget(solutionId) : 'studio/solutions';
    return {
        source: 'deployment',
        label: t('approvals.source_deployment', 'Deployment'),
        text: row.automationTitle || row.prompt || '',
        target,
        href: hrefOf(target),
    };
}

/**
 * The first fact of a row's meta line: which automation asked, or, for a
 * deployment, "Deployment · <what is deployed>".
 */
export function approvalOriginText(row, t) {
    const deployment = approvalSourceInfo(row, t);
    if (deployment) return [deployment.label, deployment.text].filter(Boolean).join(' · ');
    return row?.automationTitle || t('approvals.automation', 'Automation');
}
