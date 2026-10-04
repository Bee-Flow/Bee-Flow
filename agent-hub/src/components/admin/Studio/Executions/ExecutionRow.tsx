import React, { useState } from 'react';
import type { ComponentType } from 'react';
import { MoreHorizontal, RotateCcw, Ban, Check, X, ExternalLink, Copy, Eye, Link2, Loader2 } from 'lucide-react';
import { statusLabel, tokenFor } from '../../../shared/statusTokens';
import { RunStatusIcon, DryRunBadge } from '../AutomationsStudio/RunStatusBits';
import ContextMenuJs from '../AutomationsStudio/ContextMenu';
import { formatRelative, formatDuration, absoluteTime } from '../AutomationsStudio/historyUtils';
import type useAutomationApi from '../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { howStartedText, stepBars, stepsText } from '../../../automation/Builder/runs/runOutcome';
import { StepBars } from '../../../automation/Builder/runs/RunStatusIcon';
import { enteredTriggerLabel, runTitle } from './runLanguage';
import { runLogSentence, sentenceTooltip } from './runLogSentence';
import type { RunLogRow } from './runLogSentence';

// A .jsx module whose `= null` defaults would type its props as null-only.
const ContextMenu = ContextMenuJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * The log's columns by the list's OWN width (@container/runlog, set by
 * ExecutionsTable), never the viewport. Header and rows use the same three
 * templates, and every cell that a stage hides is display:none there, so the
 * visible cells always match the template.
 *
 *   under 76rem (laptops)  Outcome · What ran, with what happened under it · Started · ⋯
 *   from 76rem             Outcome · What ran · What happened · Started · Took · ⋯
 *   from 100rem            ... plus Steps (where it stopped) and Started by
 */
export const RUN_LOG_GRID = [
    'grid items-center gap-x-3',
    'grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)_6rem_2.25rem]',
    '@[76rem]/runlog:grid-cols-[minmax(7rem,9rem)_minmax(12rem,1fr)_minmax(16rem,2fr)_6.5rem_4.5rem_2.25rem]',
    '@[100rem]/runlog:grid-cols-[minmax(7rem,9rem)_minmax(14rem,1fr)_minmax(18rem,2fr)_8rem_6.5rem_4.5rem_10rem_2.25rem]',
].join(' ');
/** Cells shown from the middle stage on. */
export const FROM_WIDE = 'hidden @[76rem]/runlog:block';
/** Cells shown only at the widest stage. */
export const FROM_WIDEST = 'hidden @[100rem]/runlog:block';

type AutomationApi = ReturnType<typeof useAutomationApi>;

export interface ExecutionRowProps {
    run: RunLogRow;
    isGlobal: boolean;
    api: AutomationApi;
    patchRow: (runId: string, patch: Record<string, unknown>) => void;
    refresh: () => void;
    canOpen?: boolean;
    onOpen: () => void;
    onOpenEditor?: ((automationId: string) => void) | null;
}

const TONE_CLS = {
    error: 'text-[var(--error-ink)]',
    warn: 'text-[var(--warning-ink)]',
    neutral: 'text-[var(--text-secondary)]',
} as const;

/** "manually by Mark", as a cell: first letter up. */
function startedByText(t: TranslateFn, run: RunLogRow): string {
    const s = howStartedText(t, run);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** "22m ago" and "9.4s"; a dash for what is not known (yet). */
function whenText(run: RunLogRow, running: boolean) {
    return {
        started: run.startedAt ? formatRelative(run.startedAt) : '—',
        took: formatDuration(run.durationMs) || (running ? '…' : '—'),
    };
}

function copyRunLink(runId: string) {
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('view', 'runs');
        url.searchParams.set('run', runId);
        url.searchParams.delete('step');
        navigator.clipboard?.writeText(url.toString());
    } catch { /* clipboard blocked: nothing useful to do */ }
}

type MenuItem = { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean };

/** The ⋯ menu of one row, and the state of the action it started. */
function useRowActions({ run, api, patchRow, refresh, onOpen, onOpenEditor }: ExecutionRowProps) {
    const [pending, setPending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const act = async (fn: () => Promise<unknown>, optimistic?: Record<string, unknown>) => {
        if (pending) return;
        setPending(true);
        setActionError(null);
        if (optimistic) patchRow(run.id, optimistic);
        try { await fn(); } catch (e) {
            // Swallowing left the button silently resetting: say what failed.
            setActionError(`Couldn't do that: ${(e as Error)?.message || 'unknown error'}`);
        } finally { setPending(false); refresh(); }
    };

    // awaiting_confirm is a RUN-level gate and routes to /runs/:id/approve;
    // approve-step answers a step-level awaiting_approval.
    const isAwaitStep = run.status === 'awaiting_approval';
    const isAwaitRun = run.status === 'awaiting_confirm';
    const running = run.status === 'running' || run.status === 'queued';
    // One row can stand for a whole journey (a form that paused, was answered
    // and continued in another run). The status shown is that last leg's, so
    // the actions that ACT on the status address it too.
    const liveId = run.journeyRunId || run.id;
    const automationId = run.automationId || '';
    const items: Array<MenuItem | false | ''> = [
        run.status === 'error' && { label: 'Run it again', icon: <RotateCcw size={14} />, onClick: () => act(() => api.retryRun(automationId, liveId)) },
        running && { label: 'Stop it', icon: <Ban size={14} />, onClick: () => act(() => api.cancelRun(liveId), { status: 'cancelled' }), danger: true },
        (isAwaitStep || isAwaitRun) && { label: 'Approve', icon: <Check size={14} />, onClick: () => act(() => (isAwaitRun ? api.approveRun(liveId, 'approve') : api.approveStep(liveId, 'approve'))) },
        // A STEP rejection needs a reason (server-enforced), so the menu routes
        // to the run view's decision panel. A RUN-level first-run rejection is
        // one word, decided here in one click, meaning the same as in the run
        // view's bar: this run is closed and the confirm gate stays on.
        isAwaitRun && { label: 'Reject', icon: <X size={14} />, onClick: () => act(() => api.approveRun(liveId, 'reject'), { status: 'cancelled' }), danger: true },
        isAwaitStep && { label: 'Review & decide', icon: <Eye size={14} />, onClick: onOpen },
        { label: 'Open this run', icon: <Eye size={14} />, onClick: onOpen },
        { label: 'Copy a link to this run', icon: <Link2 size={14} />, onClick: () => copyRunLink(run.id) },
        automationId && { label: 'Open in editor', icon: <ExternalLink size={14} />, onClick: () => onOpenEditor?.(automationId) },
        { label: 'Copy run id', icon: <Copy size={14} />, onClick: () => { navigator.clipboard?.writeText(run.id).catch(() => {}); } },
    ];
    return { menuItems: items.filter((i): i is MenuItem => !!i), pending, actionError };
}

/** Outcome: the dot reads the row's own token, one answer for "running". */
function OutcomeCell({ run, running }: { run: RunLogRow; running: boolean }) {
    const { t } = useTranslation();
    const token = tokenFor(run.status);
    return (
        <span className="inline-flex items-center gap-1.5 min-w-0">
            {running ? <span className={`w-1.5 h-1.5 rounded-full bg-current animate-pulse flex-shrink-0 ${token.solid}`} /> : null}
            <RunStatusIcon status={run.status} size={14} />
            <span className={`text-xs font-medium truncate ${token.solid}`}>{statusLabel(t, token)}</span>
        </span>
    );
}

/**
 * What ran: the title (global) or the run's own name (scoped). On a laptop
 * the sentence (`children`) sits under it, so both get the row's width.
 */
function WhatRanCell({ run, isGlobal, children }: { run: RunLogRow; isGlobal: boolean; children: React.ReactNode }) {
    const isDry = run.mode === 'dry_run' || !!run.isTest;
    return (
        <span className="min-w-0 flex flex-col gap-0.5">
            <span className="min-w-0 flex items-center gap-2">
                <span className="text-sm text-[var(--text-primary)] truncate">
                    {isGlobal ? (run.automationTitle || 'Untitled') : runTitle(run)}
                </span>
                {isDry && <DryRunBadge />}
                {run.automationKind === 'block' && <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] flex-shrink-0">Step</span>}
            </span>
            {children}
        </span>
    );
}

/**
 * The ⋯ button. Absent, not disabled, on a row this caller does not own:
 * every item is a route that 403s for anyone but the owner. The empty span
 * keeps the grid intact.
 */
function ActionsCell({ canOpen, pending, onMenu }: { canOpen: boolean; pending: boolean; onMenu: (at: { x: number; y: number }) => void }) {
    if (!canOpen) return <span aria-hidden="true" />;
    return (
        <button
            type="button"
            data-testid="execution-row-actions"
            onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu({ x: r.right - 8, y: r.bottom }); }}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition justify-self-end"
            title="Actions"
        >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={16} />}
        </button>
    );
}

function ExecutionRowImpl(props: ExecutionRowProps) {
    const { run, isGlobal, canOpen = true, onOpen } = props;
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const { menuItems, pending, actionError } = useRowActions(props);
    const { t } = useTranslation();
    const running = run.status === 'running' || run.status === 'queued';
    const sentence = runLogSentence(t, run);
    const sentenceTip = sentenceTooltip(t, sentence);
    const toneCls = TONE_CLS[sentence.tone];
    const steps = stepsText(t, run);
    const entered = enteredTriggerLabel(run);
    const when = whenText(run, running);

    return (
        <div
            /* Not a button when there is nothing behind it: a row that still
               takes focus and answers Enter is a promise the server refuses. */
            role={canOpen ? 'button' : undefined}
            tabIndex={canOpen ? 0 : undefined}
            data-testid="execution-row"
            data-can-open={canOpen ? 'true' : 'false'}
            onClick={canOpen ? onOpen : undefined}
            onKeyDown={canOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
            className={`${RUN_LOG_GRID} px-4 py-2.5 border-b border-[var(--border-subtle,var(--border-default))] transition group ${canOpen ? 'hover:bg-[var(--bg-secondary)] cursor-pointer' : 'cursor-default'}`}
        >
            <OutcomeCell run={run} running={running} />
            <WhatRanCell run={run} isGlobal={isGlobal}>
                <span className={`@[76rem]/runlog:hidden text-xs truncate ${toneCls}`} title={sentenceTip}>{sentence.text}</span>
            </WhatRanCell>

            {/* What happened: the plain sentence; a raw server message only in the hover. */}
            <span className={`${FROM_WIDE} text-xs truncate ${toneCls}`} title={sentenceTip}>{sentence.text}</span>

            {/* Steps: one bar per step, where it stopped. */}
            <span className={`${FROM_WIDEST} min-w-0 overflow-hidden`} title={steps || undefined}>
                <StepBars statuses={stepBars(run)} />
            </span>

            {/* Started: relative on screen, the real clock time in the hover. */}
            <span className="text-xs text-[var(--text-secondary)] truncate" title={absoluteTime(run.startedAt)}>
                {when.started}
            </span>

            <span className={`${FROM_WIDE} text-xs text-[var(--text-secondary)] tabular-nums truncate`}>
                {when.took}
            </span>

            {/* Started by, and for an automation with several triggers WHICH entry point. */}
            <span className={`${FROM_WIDEST} text-xs text-[var(--text-tertiary)] truncate`} title={[startedByText(t, run), entered || ''].filter(Boolean).join(' · ')}>
                {startedByText(t, run)}
                {entered && <span className="text-[var(--text-secondary)]"> · {entered}</span>}
            </span>

            <ActionsCell canOpen={canOpen} pending={pending} onMenu={setMenu} />
            {actionError && (
                <div role="alert" className="col-span-full text-xs text-[var(--error-ink)]">{actionError}</div>
            )}
            <ContextMenu position={menu} items={menuItems} onClose={() => setMenu(null)} />
        </div>
    );
}

// Memoized so a live SSE tick that patches ONE row's `run` doesn't re-render
// every accumulated row. The function props only ever act on this row's own
// run, so the comparator keys on the data props and ignores them.
const ExecutionRow = React.memo(ExecutionRowImpl, (prev, next) =>
    prev.run === next.run
    && prev.isGlobal === next.isGlobal
    && prev.api === next.api
    && prev.patchRow === next.patchRow
    // A row that changes from openable to not has to re-render, or a scope
    // switch would leave a colleague's row clickable.
    && prev.canOpen === next.canOpen,
);

export default ExecutionRow;
