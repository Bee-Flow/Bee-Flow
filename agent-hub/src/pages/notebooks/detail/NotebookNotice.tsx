/**
 * NotebookNotice — the one place under the notebook header where an outcome
 * the user asked for is reported: an export that failed, a file saved to
 * Nextcloud (with its folder), a live session that needs rejoining. One
 * component instead of a banner here, a toast there and a custom strip for
 * Nextcloud. Dismissible; never a modal.
 */
import React from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import type { NotebookNotice as Notice } from './useNotebookExports';

export interface NoticeWithAction extends Notice {
    action?: { label: string; onClick: () => void } | null;
}

export default function NotebookNotice({ notice, onDismiss }: { notice: NoticeWithAction | null; onDismiss: () => void }) {
    const { t } = useTranslation();
    if (!notice) return null;
    const error = notice.kind === 'error';
    const tone = error
        ? 'border-[var(--error)] text-[var(--error-ink)]'
        : notice.kind === 'success' ? 'border-[var(--success)] text-[var(--success-ink)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]';
    const Icon = error ? AlertCircle : notice.kind === 'success' ? CheckCircle2 : Info;
    return (
        <div
            role={error ? 'alert' : 'status'}
            className={`mx-4 mt-2 flex items-center gap-2 px-3 py-2 rounded-xl border text-[12.5px] bg-[var(--bg-secondary)] ${tone}`}
            data-testid="notebook-notice"
        >
            <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0 break-words">{notice.message}</span>
            {notice.link && (
                <a href={notice.link.href} target="_blank" rel="noopener noreferrer" className="shrink-0 underline font-medium">{notice.link.label}</a>
            )}
            {notice.action && (
                <button type="button" onClick={notice.action.onClick} className="shrink-0 underline font-medium">{notice.action.label}</button>
            )}
            <button type="button" onClick={onDismiss} className="shrink-0 p-0.5 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('notebooks.dismiss', 'Dismiss')}>
                <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
        </div>
    );
}
