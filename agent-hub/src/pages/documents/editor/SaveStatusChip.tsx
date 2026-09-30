// "Is my work saved?" — one quiet chip for both document editors. Unsaved
// changes say so until the save starts (never "Saving…" per keystroke),
// "Saved 2m ago" stays on screen once something was saved, and a failed save
// is a button that retries.

import { AlertTriangle, Check, CircleDot, GitMerge, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import type { SaveState } from '../useDocumentAutosave';

export interface SaveStatusChipProps {
    state: SaveState;
    lastSavedAt: Date | null;
    onRetry?: () => void;
    onResolve?: () => void;
}

const BASE = 'inline-flex items-center gap-1 text-[11px] shrink-0 text-[var(--text-tertiary)]';

/** Re-render every 30 s while a "saved … ago" is on screen. */
function useTick(active: boolean) {
    const [, tick] = useState(0);
    useEffect(() => {
        if (!active) return undefined;
        const h = setInterval(() => tick((n) => n + 1), 30_000);
        return () => clearInterval(h);
    }, [active]);
}

export default function SaveStatusChip({ state, lastSavedAt, onRetry, onResolve }: SaveStatusChipProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const showsAge = !!lastSavedAt && (state === 'saved' || state === 'idle');
    useTick(showsAge);
    if (state === 'error') {
        return (
            <button type="button" onClick={onRetry} className={`${BASE} text-[var(--error)] hover:underline`} data-testid="document-save-state" data-state={state}>
                <AlertTriangle size={12} aria-hidden="true" />{t('documents.save.failed_retry', 'Not saved — retry')}
            </button>
        );
    }
    if (state === 'conflict') {
        return (
            <button type="button" onClick={onResolve} className={`${BASE} text-[var(--warning,var(--text-primary))] hover:underline`} data-testid="document-save-state" data-state={state}>
                <GitMerge size={12} aria-hidden="true" />{t('documents.save.needs_choice', 'Changed by someone else — choose')}
            </button>
        );
    }
    const content: Record<string, React.ReactNode> = {
        unsaved: <><CircleDot size={12} aria-hidden="true" />{t('documents.save.unsaved', 'Unsaved changes')}</>,
        saving: <><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t('documents.save.saving', 'Saving…')}</>,
    };
    const body = content[state] || (showsAge
        ? <><Check size={12} aria-hidden="true" />{t('documents.save.saved_ago', 'Saved {time}', { time: rel(lastSavedAt) })}</>
        : null);
    if (!body) return <span className="w-16 shrink-0" data-testid="document-save-state" data-state={state} />;
    return <span role="status" aria-live="polite" className={BASE} data-testid="document-save-state" data-state={state}>{body}</span>;
}
