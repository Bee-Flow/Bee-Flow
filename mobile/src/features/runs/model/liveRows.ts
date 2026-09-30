/**
 * A live run event merged into the rows on screen — the web's
 * useExecutions.applyEvent, as a pure function over one list.
 *
 * The stream is a notification, not the record: it carries the LEG that fired
 * (a routine continued after a form runs in a child run the list never shows),
 * so an event addresses its journey's head row and a continuation is never
 * inserted as a row of its own. A run that has just started is only inserted
 * when the status chip would show it. Everything else waits for the refetch.
 */

import type { RunEvent } from '@/features/automations';

import type { RunFilters } from './filters';
import type { LogRun } from './types';

/** The frame as it arrives: RunEvent plus the fields the runner adds to a start. */
export type LiveRunEvent = RunEvent & {
    rootRunId?: unknown;
    title?: unknown;
    kind?: unknown;
    mode?: unknown;
};

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function stub(event: LiveRunEvent, rowId: string): LogRun {
    return {
        id: rowId,
        journeyRunId: event.runId ?? null,
        automationId: event.automationId ?? '',
        automationTitle: str(event.title),
        automationKind: str(event.kind) ?? 'automation',
        triggerKind: event.triggerKind ?? null,
        rootStepId: null,
        rootTriggerLabel: null,
        mode: str(event.mode) ?? 'live',
        status: event.status ?? 'running',
        startedAt: event.at ?? new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        summary: null,
        error: null,
        errorClass: null,
        handledErrorCount: 0,
    };
}

function settled(row: LogRun, event: LiveRunEvent, isContinuation: boolean): LogRun {
    return {
        ...row,
        journeyRunId: event.runId ?? row.journeyRunId,
        status: event.status || row.status,
        // A leg reports its own duration; the row measures the whole journey.
        durationMs: isContinuation ? row.durationMs : (event.durationMs ?? row.durationMs),
        error: event.error ?? row.error,
        errorClass: event.errorClass ?? row.errorClass,
    };
}

/** The rows after `event`, or the same array when it changes nothing. */
export function applyRunEvent(rows: readonly LogRun[], event: LiveRunEvent, filters: RunFilters): readonly LogRun[] {
    if (!event?.runId || event.type.startsWith('step.')) return rows;
    if (filters.automationId && event.automationId && event.automationId !== filters.automationId) return rows;
    const rowId = str(event.rootRunId) ?? event.runId;
    const isContinuation = rowId !== event.runId;
    const idx = rows.findIndex((r) => r.id === rowId);
    if (event.type === 'run.started') {
        if (idx >= 0) return rows.map((r, i) => (i === idx ? { ...r, status: event.status || 'running' } : r));
        const shows = filters.status === 'all' || filters.status === 'running';
        if (!shows || isContinuation || !event.automationId) return rows;
        return [stub(event, rowId), ...rows];
    }
    if (idx < 0) return rows;
    return rows.map((r, i) => (i === idx ? settled(r, event, isContinuation) : r));
}
