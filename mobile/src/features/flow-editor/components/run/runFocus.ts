/**
 * "Where the run is" — the line over the flow while a test run goes and after
 * it stopped. A port of the web builder's flow/runFocus.js
 * `computeRunFocus` and shared/builder/formatElapsed.js, pinned by
 * run.lockstep.test.ts (differential).
 *
 * The rule the web learned the hard way (BFSF-364): the line may only talk
 * about steps that are on the flow NOW. The last run's rows describe the
 * graph as it was; delete the step that failed and a row for it would name a
 * node that is gone, by its raw id, and count "7/6". Rows whose step is gone
 * are dropped before anything is derived from them.
 */

import type { AnyNode, DefinitionInput } from '@/features/flow-editor/model';

export interface FocusRow {
    stepId?: string | null;
    status?: string | null;
    startedAt?: string | null;
}

export interface RunFocus {
    stepId: string | null;
    label: string;
    done: number;
    total: number;
    state: 'running' | 'error';
    /** When the RUN began: the earliest row's start. */
    startedAt: string | null;
    /** The step the line names is parked on a form page. */
    awaitingForm: boolean;
}

// Rows in these states have finished their work and count toward progress.
const DONE_STATES = ['success', 'skipped', 'pinned'];
const AWAITING_FORM = 'awaiting_form';

function liveGraph(definition: DefinitionInput): AnyNode[] {
    return [definition?.trigger, ...(definition?.steps || [])].filter((n): n is AnyNode => !!n);
}

function labelOf(step: AnyNode | null | undefined, stepId: string | null): string {
    if (!step) return stepId || '';
    const tool = (step as { tool?: unknown }).tool;
    return step.label || (typeof tool === 'string' ? tool : '') || stepId || '';
}

function earliestStart(rows: readonly FocusRow[]): string | null {
    let best: number | null = null;
    for (const r of rows) {
        const t = Date.parse(r?.startedAt || '');
        if (!Number.isFinite(t)) continue;
        if (best == null || t < best) best = t;
    }
    return best == null ? null : new Date(best).toISOString();
}

export function computeRunFocus({
    runSteps,
    runInFlight = false,
    definition,
}: { runSteps?: readonly FocusRow[] | null; runInFlight?: boolean; definition?: DefinitionInput } = {}): RunFocus | null {
    const graph = liveGraph(definition);
    const liveIds = new Set(graph.map((s) => s.id).filter(Boolean));
    const rows = (runSteps || []).filter((s) => s?.stepId && liveIds.has(s.stepId));
    const found = targetOf(rows, runInFlight);
    if (!found.target?.stepId && !runInFlight) return null;

    const stepId = found.target?.stepId || null;
    const step = stepId ? graph.find((s) => s.id === stepId) : null;
    return {
        stepId,
        label: labelOf(step, stepId),
        done: rows.filter((s) => DONE_STATES.includes(String(s.status))).length,
        total: graph.length,
        state: found.moving ? 'running' : found.failed ? 'error' : 'running',
        startedAt: earliestStart(rows),
        awaitingForm: !!found.target && found.target === found.waiting,
    };
}

/** The row the line names: a running step, else one parked on a form, else (once over) the failure. */
function targetOf(rows: readonly FocusRow[], runInFlight: boolean) {
    const running = rows.find((s) => s.status === 'running');
    const waiting = rows.find((s) => s.status === AWAITING_FORM);
    const failed = rows.find((s) => s.status === 'error');
    // A run parked on a form IS the run, so it names the line when nothing executes.
    const target = running || waiting || (runInFlight ? null : failed);
    return { target, waiting, failed, moving: !!(running || waiting) };
}

/** "12m 33s": seconds under a minute, m+s under an hour, h+m above; null for an unreadable start. */
export function formatElapsed(startedAt: string | null | undefined, now: number = Date.now()): string | null {
    const start = Date.parse(startedAt || '');
    if (!Number.isFinite(start)) return null;
    const secs = Math.max(0, Math.floor((now - start) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
