import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import AnchoredMenu from '../../../../shared/AnchoredMenu';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * App Studio editor — what autosave has to say, in two pieces (Studio
 * artboard 1b):
 *
 *   SaveStatusChip     the 11px "Saved · v12" chip beside the app name
 *                      (radius 999, border-default). "Saving…" while a save is
 *                      in flight; the version is the canvas version the shell
 *                      already tracks.
 *   SaveNoticeCapsule  the 32px "⚠ 1 to check" capsule right of the segments
 *                      (radius 10, --warning border, --warning-ink text) — a
 *                      button that opens SaveNoticesPanel. It exists only when
 *                      the server actually said something about the last save,
 *                      so it can never nag. A failed save turns it into the
 *                      --error capsule with Retry.
 *   SaveNoticesPanel   the list behind the capsule, one row per server entry.
 *
 * Colours are the theme's status tokens only: --warning / --warning-ink and
 * --error / --error-ink (the artboard's #8a5a00 is the light-theme value of
 * --warning-ink; the repo's hygiene test forbids the literal).
 */

export function SaveStatusChip({ status, version = null }) {
    const { t } = useTranslation();
    const saving = status === 'saving';
    const label = saving
        ? t('app_studio.header.saving', 'Saving…')
        : (version != null
            ? t('app_studio.header.saved_version', 'Saved · v{version}', { version })
            : t('app_studio.header.saved', 'Saved'));
    return (
        <span
            role="status"
            data-testid="save-status-chip"
            data-save-status={status || 'idle'}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[3px] text-[11px] leading-none"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
        >
            {saving
                ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                : <Check className="h-3 w-3" style={{ color: 'var(--success)' }} aria-hidden="true" />}
            {label}
        </span>
    );
}

export function SaveNoticeCapsule({ status, error, onRetry, noticeCount = 0, noticesOpen = false, onToggleNotices }) {
    const { t } = useTranslation();
    if (status === 'error') {
        return (
            <span
                className="inline-flex h-8 max-w-72 items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-2.5 text-xs font-medium"
                style={{
                    borderColor: 'color-mix(in srgb, var(--error) 40%, transparent)',
                    color: 'var(--error-ink)',
                    background: 'color-mix(in srgb, var(--error) 8%, transparent)',
                }}
                role="status"
                data-testid="save-notice-capsule"
                data-tone="error"
            >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate" title={error || t('app_studio.header.save_failed', 'Saving failed')}>
                    {error || t('app_studio.header.save_failed', 'Saving failed')}
                </span>
                {/* The line above is the FIRST of several — offer the rest. */}
                {noticeCount > 1 ? (
                    <button
                        type="button"
                        onClick={onToggleNotices}
                        aria-expanded={noticesOpen}
                        className="shrink-0 font-semibold underline underline-offset-2"
                    >
                        {t('app_studio.header.all_notices', 'All {count}', { count: noticeCount })}
                    </button>
                ) : null}
                <button type="button" onClick={onRetry} className="shrink-0 font-semibold underline underline-offset-2">
                    {t('app_studio.header.retry', 'Retry')}
                </button>
            </span>
        );
    }
    if (noticeCount > 0) {
        return (
            <button
                type="button"
                onClick={onToggleNotices}
                aria-expanded={noticesOpen}
                className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-2.5 text-xs font-medium"
                style={{ borderColor: 'var(--warning)', color: 'var(--warning-ink)', background: 'var(--bg-card)' }}
                data-testid="save-notice-capsule"
                data-tone="warning"
            >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {noticeCount === 1
                    ? t('app_studio.header.to_check_one', '1 to check')
                    : t('app_studio.header.to_check', '{count} to check', { count: noticeCount })}
            </button>
        );
    }
    return null;
}

/**
 * The list behind the capsule: one row per server entry, in the server's
 * words. Portalled (AnchoredMenu) so the center column's overflow-x-clip —
 * and any other ancestor — can never cut it off; the capsule may sit anywhere
 * in a wrapped header row and the panel still lays out fully on screen.
 */
export function SaveNoticesPanel({ open, anchorRef, notices, onShow, onClose }) {
    const { t } = useTranslation();
    return (
        <AnchoredMenu
            open={open}
            onClose={onClose}
            anchorRef={anchorRef}
            align="right"
            width={320}
            role="dialog"
            aria-label={t('app_studio.header.notices_aria', 'What the last save reported')}
            className="p-2"
            style={{ background: 'var(--bg-secondary)' }}
        >
            <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                    {t('app_studio.header.notices_title', 'From the last save')}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('app_studio.header.close', 'Close')}
                    className="rounded p-0.5 hover:bg-[var(--bg-tertiary)]"
                    style={{ color: 'var(--text-tertiary)' }}
                >
                    <X className="h-3 w-3" aria-hidden="true" />
                </button>
            </div>
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                {notices.map((entry, i) => (
                    <li
                        key={`${entry.kind}-${entry.path}-${i}`}
                        className="rounded-md px-2 py-1.5"
                        style={{ background: 'var(--bg-tertiary)' }}
                    >
                        <div className="text-xs" style={{ color: 'var(--text-primary)' }}>{entry.message}</div>
                        {entry.hint ? (
                            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{entry.hint}</div>
                        ) : null}
                        {entry.target ? (
                            <button
                                type="button"
                                onClick={() => onShow(entry)}
                                className="mt-1 text-[11px] font-semibold underline underline-offset-2"
                                style={{ color: 'var(--accent-primary)' }}
                            >
                                {t('app_studio.header.show_me', 'Show me')}
                            </button>
                        ) : null}
                    </li>
                ))}
            </ul>
        </AnchoredMenu>
    );
}

export default SaveNoticeCapsule;
