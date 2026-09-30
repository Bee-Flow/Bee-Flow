/**
 * NotebookSaveStatus — the one answer to "is my work saved?" in the notebook
 * header, in the same spirit as the shared SaveStatus chip (it keeps saying
 * "Saved 2m ago" instead of vanishing), with the states a notebook has on top:
 *
 *   live       co-edited: every change is shared (and saved) as it is typed
 *   connecting joining the live session
 *   offline    the live session lost the connection; typing is kept and sent
 *              when it is back
 *   conflict   a save lost a race; the choice is waiting below the header
 *   read-only  nothing to save
 *
 * Announced to assistive tech (role="status"); an error is a retry button.
 */
import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, CircleDot, CloudOff, Loader2, Radio } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import useRelativeTime from '../../../hooks/useRelativeTime';

export type NotebookSaveMode = 'saving' | 'error' | 'conflict' | 'dirty' | 'idle' | 'live' | 'connecting' | 'offline' | 'readonly';

interface Props {
    mode: NotebookSaveMode;
    lastSavedAt?: number | null;
    onRetry?: () => void;
}

const BASE = 'inline-flex items-center gap-1 text-[12px] whitespace-nowrap';

export default function NotebookSaveStatus({ mode, lastSavedAt, onRetry }: Props) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    // "just now" must not still say so ten minutes later.
    const [, tick] = useState(0);
    const showsAge = mode === 'idle' && !!lastSavedAt;
    useEffect(() => {
        if (!showsAge) return undefined;
        const h = setInterval(() => tick((n) => n + 1), 30_000);
        return () => clearInterval(h);
    }, [showsAge]);

    const status = (icon: React.ReactNode, text: string, tone = 'text-[var(--text-tertiary)]') => (
        <span role="status" aria-live="polite" className={`${BASE} ${tone}`} data-testid={`save-status-${mode}`}>
            {icon}{text}
        </span>
    );

    switch (mode) {
        case 'saving':
            return status(<Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />, t('notebooks.saving', 'Saving…'));
        case 'error':
            return (
                <button type="button" onClick={onRetry} className={`${BASE} text-[var(--error)] hover:underline`} data-testid="save-status-error">
                    <AlertCircle className="w-3 h-3" aria-hidden="true" />{t('notebooks.save_failed_retry', 'Save failed — retry')}
                </button>
            );
        case 'conflict':
            return status(<AlertCircle className="w-3 h-3" aria-hidden="true" />, t('notebooks.save_conflict', 'Changed elsewhere — choose below'), 'text-[var(--warning-ink,var(--text-secondary))]');
        case 'dirty':
            return status(<CircleDot className="w-3 h-3" aria-hidden="true" />, t('notebooks.unsaved_changes', 'Unsaved changes'));
        case 'live':
            return status(<Radio className="w-3 h-3" aria-hidden="true" />, t('notebooks.saved_live', 'Saved as you type'));
        case 'connecting':
            return status(<Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />, t('notebooks.live_connecting', 'Joining the live session…'));
        case 'offline':
            return status(<CloudOff className="w-3 h-3" aria-hidden="true" />, t('notebooks.live_offline', 'Offline — your changes are kept and sent when you are back'));
        case 'readonly':
            return null;
        default:
            if (!lastSavedAt) return null;
            return status(<Check className="w-3 h-3" aria-hidden="true" />, t('notebooks.saved_ago', 'Saved {when}', { when: rel(lastSavedAt) }));
    }
}
