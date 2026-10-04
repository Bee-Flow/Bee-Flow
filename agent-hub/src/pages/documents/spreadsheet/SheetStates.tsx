// The editor's states around the grid: notices, the loading skeleton and the
// load error.

import React from 'react';
import useTranslation from '../../../hooks/useTranslation';

export const BUTTON = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[13px] font-medium bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 transition';

export function Notice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <div role="alert" className="shrink-0 flex items-center gap-3 px-4 py-2 text-[13px] border-b border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--error)]">
            <span className="flex-1 min-w-0">{children}</span>
            {action}
        </div>
    );
}

export function SheetSkeleton() {
    const { t } = useTranslation();
    return (
        <div className="flex-1 min-h-0 p-4 space-y-2" role="status" aria-busy="true" data-testid="sheet-loading">
            <span className="sr-only">{t('spreadsheet.loading', 'Loading the spreadsheet…')}</span>
            {Array.from({ length: 12 }, (_, i) => <div key={i} className="h-6 rounded bg-[var(--bg-secondary)] animate-pulse" />)}
        </div>
    );
}

export function SheetLoadError({ onRetry, onBack }: { onRetry: () => void; onBack?: () => void }) {
    const { t } = useTranslation();
    return (
        <div role="alert" className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="sheet-load-error">
            <p className="m-0 text-[14px] text-[var(--text-primary)]">{t('spreadsheet.load_failed', 'Could not load the spreadsheet.')}</p>
            <div className="flex gap-2">
                <button type="button" className={BUTTON} onClick={onRetry}>{t('spreadsheet.retry', 'Retry')}</button>
                {onBack && <button type="button" className={BUTTON} onClick={onBack}>{t('documents.back', 'Back to Documents')}</button>}
            </div>
        </div>
    );
}
