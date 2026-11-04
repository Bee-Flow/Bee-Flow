import React, { useState } from 'react';
import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import type { ActionEntry, ActionState } from './actionRunner/core';

type Translate = ReturnType<typeof useTranslation>['t'];

/** The line a running job shows: its progress text, the loop position, a budget wait, or the step count. */
function progressLine(entry: ActionEntry, t: Translate): string {
    const p = entry.progress;
    if (p?.waiting === 'budget') return t('studio_apps_runtime.background.waiting_budget', 'Waiting for the AI budget…');
    if (p?.message) return p.message;
    if (p?.loop) return t('studio_apps_runtime.background.item_of', 'Item {i} of {n}', { i: p.loop.index + 1, n: p.loop.count });
    if (p && p.executed > 0) return t('studio_apps_runtime.background.step_n', 'Step {n}', { n: p.executed });
    return t('studio_apps_runtime.background.starting', 'Starting…');
}

function Row({ entry, onDismiss, t }: { entry: ActionEntry; onDismiss: () => void; t: Translate }) {
    const running = entry.status === 'running';
    const failed = entry.status === 'error';
    let text = progressLine(entry, t);
    if (failed) text = entry.error || t('studio_apps_runtime.actions.failed', 'The action failed.');
    else if (!running) text = t('studio_apps_runtime.background.finished', 'Finished');
    return (
        <li className="flex items-start gap-2 px-3 py-2 text-sm" data-background-job={entry.jobId} data-status={entry.status}>
            {running && <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin [color:var(--app-primary)]" aria-hidden="true" />}
            {!running && !failed && <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 [color:var(--app-primary)]" aria-hidden="true" />}
            {failed && <XCircle className="w-4 h-4 mt-0.5 shrink-0 [color:var(--error)]" aria-hidden="true" />}
            <span className="flex-1 min-w-0 break-words">{text}</span>
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
 * nothing when there are none.
 */
export default function BackgroundRunTray({ actionState }: { actionState: ActionState }) {
    const { t } = useTranslation();
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
                    <Row key={entry.jobId} entry={entry} t={t} onDismiss={() => setDismissed((prev) => new Set([...prev, entry.jobId]))} />
                ))}
            </ul>
        </div>
    );
}
