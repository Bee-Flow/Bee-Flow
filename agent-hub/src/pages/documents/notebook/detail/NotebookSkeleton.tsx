/**
 * What the notebook page shows between the click and the notebook: a
 * skeleton of the header, the sources rail and the document (the click
 * navigates at once), and — when the notebook cannot be opened — a message
 * that says why, with a way back and a retry. Loading, failed and "not
 * found" are three different screens.
 */
import React from 'react';
import { AlertCircle, ArrowLeft, RefreshCw } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';

function Bar({ className }: { className: string }) {
    return <div className={`rounded-md bg-[var(--bg-tertiary)] animate-pulse ${className}`} />;
}

export function NotebookSkeleton({ onBack }: { onBack?: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]" aria-busy="true" data-testid="notebook-skeleton">
            <span role="status" className="sr-only">{t('notebooks.opening', 'Opening the notebook…')}</span>
            <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                {onBack && (
                    <button type="button" onClick={onBack} className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]" aria-label={t('notebooks.back', 'Back')}>
                        <ArrowLeft className="w-4 h-4 text-[var(--text-secondary)]" aria-hidden="true" />
                    </button>
                )}
                <Bar className="w-10 h-10 rounded-xl" />
                <div className="flex-1 space-y-1.5">
                    <Bar className="h-4 w-56" />
                    <Bar className="h-3 w-40" />
                </div>
            </div>
            <div className="flex-1 flex overflow-hidden">
                <div className="hidden md:flex w-[248px] shrink-0 flex-col gap-2 p-3 border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                    <Bar className="h-8 w-full" />
                    <Bar className="h-12 w-full" />
                    <Bar className="h-12 w-full" />
                </div>
                <div className="flex-1 flex justify-center pt-10 px-6">
                    <div className="w-full max-w-[680px] space-y-3">
                        <Bar className="h-7 w-2/3" />
                        <Bar className="h-4 w-full" />
                        <Bar className="h-4 w-11/12" />
                        <Bar className="h-4 w-4/5" />
                    </div>
                </div>
            </div>
        </div>
    );
}

export function NotebookLoadError({ status, message, onBack, onRetry }: { status?: number; message?: string; onBack?: () => void; onRetry?: () => void }) {
    const { t } = useTranslation();
    const missing = status === 404;
    return (
        <div className="h-full flex items-center justify-center bg-[var(--bg-primary)] p-6" data-testid="notebook-load-error">
            <div role="alert" className="max-w-md w-full text-center rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 space-y-3">
                <AlertCircle className="w-8 h-8 mx-auto text-[var(--error)]" aria-hidden="true" />
                <h2 className="m-0 text-base font-semibold text-[var(--text-primary)]">
                    {missing
                        ? t('notebooks.not_found_title', 'This notebook is not available')
                        : t('notebooks.load_failed_title', 'The notebook could not be opened')}
                </h2>
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">
                    {missing
                        ? t('notebooks.not_found_body', 'It may have been deleted, or it is no longer shared with you.')
                        : (message || t('notebooks.load_failed_body', 'Check your connection and try again.'))}
                </p>
                <div className="flex justify-center gap-2 pt-1">
                    {onBack && (
                        <button type="button" onClick={onBack} className="px-3 py-1.5 rounded-lg text-[13px] font-medium border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
                            {t('notebooks.back_to_notebooks', 'Back to notebooks')}
                        </button>
                    )}
                    {!missing && onRetry && (
                        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />{t('notebooks.try_again', 'Try again')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
