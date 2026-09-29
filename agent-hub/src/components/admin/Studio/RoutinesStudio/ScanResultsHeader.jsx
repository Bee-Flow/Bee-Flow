import { RefreshCw } from 'lucide-react';
import React from 'react';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * ScanResultsHeader: "Scanned 2h ago · Scan again", the line above a scan's
 * result. Scan again fires a forced scan (bypasses caches). Shown once there
 * is a result to refer to; while a scan runs the progress line takes its place.
 */
export default function ScanResultsHeader({ lastScannedAt, onRescan, disabled = false }) {
    const { t } = useTranslation();
    const relative = useRelativeTime();
    const when = relative(lastScannedAt) || t('time.just_now', 'just now');
    return (
        <div className="flex items-center gap-2 text-[12px] text-[var(--text-tertiary)]" data-testid="scan-results-header">
            <span>{t('routines.repeating.scannedAgo', 'Scanned {when}', { when })}</span>
            <span aria-hidden="true">·</span>
            <button
                type="button"
                onClick={() => onRescan?.(true)}
                disabled={disabled}
                className="inline-flex items-center gap-1 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 transition"
            >
                <RefreshCw size={11} aria-hidden="true" />
                {t('routines.repeating.scanAgain', 'Scan again')}
            </button>
        </div>
    );
}
