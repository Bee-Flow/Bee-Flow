import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * The sidebar's note for a list that could not be read: an empty list is then
 * not "No automations yet", and the read is one click away.
 */
export default function LibraryLoadFailed({ onRetry }: { onRetry: () => unknown }) {
    const { t } = useTranslation();
    return (
        <div role="alert" className="text-xs text-[var(--error)] p-4 text-center">
            <div>{t('automations.library.loadFailed', 'Could not load your automations.')}</div>
            <button
                type="button"
                onClick={() => { void onRetry(); }}
                className="mt-2 px-3 py-1 rounded-full border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
            >
                {t('automations.library.retry', 'Try again')}
            </button>
        </div>
    );
}
