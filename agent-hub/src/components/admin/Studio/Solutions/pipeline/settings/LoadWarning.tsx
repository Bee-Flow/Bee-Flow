import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';

/** A read that failed (or is still running) said where it matters: unknown is never shown as empty. */
export default function LoadWarning({ text, onRetry, testId }: { text: string; onRetry?: () => void; testId?: string }) {
    const { t } = useTranslation();
    return (
        <p className="flex flex-wrap items-start gap-2 px-3 py-2 rounded-[var(--radius-md)] border-l-2 border-[var(--warning)] bg-[var(--bg-secondary)] text-xs text-[var(--text-primary)]" data-testid={testId}>
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span>{text}</span>
            {onRetry && <button type="button" className="underline min-h-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]" onClick={onRetry}>{t('stage_settings.retry', 'Try again')}</button>}
        </p>
    );
}
