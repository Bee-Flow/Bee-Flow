import React, { useState } from 'react';
import { Ban, CheckCircle2, Hourglass, Loader2, X, XCircle } from 'lucide-react';
import toast from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import { cancelJob } from '@/api/actionHttp';
import type { ActionEntry, ActionState } from './actionRunner/core';

type Translate = ReturnType<typeof useTranslation>['t'];

/** POST the cancel of one job; false when the server did not take it. */
async function requestCancel(appId: string, jobId: string): Promise<boolean> {
    try {
        return (await cancelJob(appId, jobId)).ok;
    } catch {
        return false;
    }
}

/** The line of a job on hold: what it waits for, or until when. */
function waitingLine(waiting: NonNullable<ActionEntry['waiting']>, t: Translate, locale: string): string {
    if (waiting.kind === 'approval') return t('studio_apps_durable.tray.waiting_approval', 'Waiting for an approval');
    const at = waiting.wakeAt ? new Date(waiting.wakeAt) : null;
    if (at && !Number.isNaN(at.getTime()) && !waiting.kind) {
        return t('studio_apps_durable.tray.waiting_until', 'Waiting until {time}', { time: at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) });
    }
    return t('studio_apps_durable.tray.waiting_open', 'Waiting to be continued');
}

/** The line a running job shows: its progress text, the loop position, a budget wait, or the step count. */
function progressLine(entry: ActionEntry, t: Translate): string {
    const p = entry.progress;
    if (p?.waiting === 'budget') return t('studio_apps_runtime.background.waiting_budget', 'Waiting for the AI budget…');
    if (p?.message) return p.message;
    if (p?.loop) return t('studio_apps_runtime.background.item_of', 'Item {i} of {n}', { i: p.loop.index + 1, n: p.loop.count });
    if (p && p.executed > 0) return t('studio_apps_runtime.background.step_n', 'Step {n}', { n: p.executed });
    return t('studio_apps_runtime.background.starting', 'Starting…');
}

/** The text of a job's row. */
function rowText(entry: ActionEntry, stopping: boolean, t: Translate, locale: string): string {
    if (entry.status === 'error') return entry.error || t('studio_apps_runtime.actions.failed', 'The action failed.');
    if (entry.cancelled) return t('studio_apps_durable.tray.cancelled', 'Cancelled');
    if (entry.status !== 'running') return t('studio_apps_runtime.background.finished', 'Finished');
    if (stopping) return t('studio_apps_durable.tray.cancelling', 'Stopping…');
    return entry.waiting ? waitingLine(entry.waiting, t, locale) : progressLine(entry, t);
}

function RowIcon({ entry }: { entry: ActionEntry }) {
    if (entry.status === 'error') return <XCircle className="w-4 h-4 mt-0.5 shrink-0 [color:var(--error)]" aria-hidden="true" />;
    if (entry.cancelled) return <Ban className="w-4 h-4 mt-0.5 shrink-0 opacity-70" aria-hidden="true" />;
    if (entry.status !== 'running') return <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 [color:var(--app-primary)]" aria-hidden="true" />;
    if (entry.waiting) return <Hourglass className="w-4 h-4 mt-0.5 shrink-0 [color:var(--app-primary)]" aria-hidden="true" />;
    return <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin [color:var(--app-primary)]" aria-hidden="true" />;
}

function Row({ entry, onDismiss, onCancel, t, locale }: { entry: ActionEntry; onDismiss: () => void; onCancel: (() => Promise<boolean>) | null; t: Translate; locale: string }) {
    const running = entry.status === 'running';
    const [stopping, setStopping] = useState(false);
    const cancel = async () => {
        if (!onCancel) return;
        setStopping(true);
        if (!(await onCancel())) setStopping(false);
    };
    return (
        <li className="flex items-start gap-2 px-3 py-2 text-sm" data-background-job={entry.jobId} data-status={entry.status} data-on-hold={entry.waiting ? 'true' : undefined}>
            <RowIcon entry={entry} />
            <span className="flex-1 min-w-0 break-words">{rowText(entry, running && stopping, t, locale)}</span>
            {running && onCancel && !stopping && (
                <button type="button" onClick={() => { void cancel(); }} className="shrink-0 text-xs underline opacity-80 hover:opacity-100">
                    {t('studio_apps_durable.tray.cancel', 'Cancel')}
                </button>
            )}
            {!running && (
                <button type="button" onClick={onDismiss} aria-label={t('studio_apps_runtime.background.dismiss', 'Dismiss')} className="shrink-0 opacity-70 hover:opacity-100">
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            )}
        </li>
    );
}

/**
 * The background jobs of this run surface: running ones with their progress, finished ones
 * until dismissed. Reads the runner's actionState (entries that carry a jobId); renders
 * nothing when there are none. With an `appId` a job that runs or is on hold can be cancelled
 * (the server stops it before its next step); the runner's poll then shows how it ended.
 * `sendCancel` is the request (injectable for tests): it answers whether the server took it.
 */
export default function BackgroundRunTray({ actionState, appId = null, sendCancel = requestCancel }: {
    actionState: ActionState; appId?: string | null; sendCancel?: (appId: string, jobId: string) => Promise<boolean>;
}) {
    const { t, locale } = useTranslation();
    const cancel = async (jobId: string): Promise<boolean> => {
        if (appId && await sendCancel(appId, jobId)) return true;
        toast.error(t('studio_apps_durable.tray.cancel_failed', 'The run could not be cancelled. Try again.'));
        return false;
    };
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
    const entries = Object.values(actionState).filter((e): e is ActionEntry & { jobId: string } => !!e && typeof e.jobId === 'string' && !dismissed.has(e.jobId));
    if (!entries.length) return null;
    return (
        <div
            role="status"
            aria-live="polite"
            data-background-run-tray="true"
            className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] border shadow-lg [border-color:var(--border-default)] [background:var(--bg-primary)] [color:var(--text-primary)] [border-radius:var(--app-radius)]"
        >
            <div className="px-3 pt-2 text-xs font-medium opacity-70">{t('studio_apps_runtime.background.title', 'Running in the background')}</div>
            <ul>
                {entries.map((entry) => (
                    <Row key={entry.jobId} entry={entry} t={t} locale={locale} onCancel={appId ? () => cancel(entry.jobId) : null} onDismiss={() => setDismissed((prev) => new Set([...prev, entry.jobId]))} />
                ))}
            </ul>
        </div>
    );
}
