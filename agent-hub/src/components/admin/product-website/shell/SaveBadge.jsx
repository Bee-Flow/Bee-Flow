import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * Save-pipeline status badge — extracted verbatim from ProductWebsitePanel.
 * The 5-state machine (idle → dirty → saving → saved / error) is driven by
 * the container's autosave machinery; `onRetry` re-flushes the failed batch.
 */
export default function SaveBadge({ status, onRetry }) {
    const { t } = useTranslation();
    const map = {
        idle:   { label: '',                  color: 'var(--text-muted)' },
        dirty:  { label: t('cms_site.site.shell.save_unsaved', '● Unsaved'),         color: '#fbbf24' },
        saving: { label: t('cms_site.site.shell.save_saving', 'Saving…'),           color: 'var(--text-secondary)' },
        saved:  { label: t('cms_site.site.shell.save_saved', '✓ Saved'),           color: '#34d399' },
        error:  { label: t('cms_site.site.shell.save_failed', '⚠ Save failed'),     color: '#f87171' },
    };
    const s = map[status] || map.idle;
    if (!s.label) return <span />;
    return (
        <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: s.color }}>
            {s.label}
            {status === 'error' && onRetry ? (
                <button
                    type="button"
                    onClick={onRetry}
                    className="ml-1 px-1.5 py-0.5 rounded border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                    {t('cms_site.site.shell.save_retry', 'Retry')}
                </button>
            ) : null}
        </span>
    );
}
