import React from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useMaintenanceWindow, coarseEta } from '../../hooks/useMaintenanceWindow';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * App-wide strip warning that a deployment is rolling and the connection will
 * drop briefly.
 *
 * Sits above the content rather than floating over it: this is a "the ground is
 * about to move" message, and a toast that can be dismissed or missed is the
 * wrong weight for it. It occupies layout only while a window is open, so the
 * normal case costs nothing.
 *
 * The copy names the concrete consequence — an answer stopping mid-sentence —
 * because "brief interruption" does not tell anyone whether to hit send.
 *
 * The 'recovered' phase (the server now runs a NEWER build than this tab's
 * bundle) is a persistent reload prompt: it stays until the user reloads,
 * because the version skew it reports does too.
 */

/** Coarse, translated ETA — the rounding lives in the hook (coarseEta). */
function etaLabel(t, seconds) {
    const { unit, value } = coarseEta(seconds);
    switch (unit) {
        case 'seconds': return t('maintenance.banner.eta_seconds', 'about {seconds} seconds', { seconds: value });
        case 'minute': return t('maintenance.banner.eta_minute', 'about a minute');
        case 'minutes': return t('maintenance.banner.eta_minutes', 'about {minutes} minutes', { minutes: value });
        default: return t('maintenance.banner.eta_moment', 'any moment now');
    }
}

export default function MaintenanceBanner({ enabled = true }) {
    const { phase, secondsRemaining } = useMaintenanceWindow({ enabled });
    const { t } = useTranslation();

    if (phase === 'idle') return null;

    const style = {
        pending: {
            Icon: RefreshCw,
            spin: true,
            bg: 'rgba(245, 158, 11, 0.12)',
            border: 'rgba(245, 158, 11, 0.35)',
            fg: 'rgb(146, 64, 14)',
            title: t('maintenance.banner.pending_title', 'Update being installed'),
            body: t('maintenance.banner.pending_body', 'The connection will drop for a moment — an answer in progress may stop mid-sentence. You can continue in {eta}.', { eta: etaLabel(t, secondsRemaining) }),
        },
        overdue: {
            Icon: AlertTriangle,
            spin: false,
            bg: 'rgba(245, 158, 11, 0.12)',
            border: 'rgba(245, 158, 11, 0.35)',
            fg: 'rgb(146, 64, 14)',
            title: t('maintenance.banner.overdue_title', 'Update is taking longer than expected'),
            body: t('maintenance.banner.overdue_body', 'Still reconnecting. Your work is saved — this page will say so as soon as the update lands.'),
        },
        recovered: {
            Icon: CheckCircle2,
            spin: false,
            bg: 'rgba(34, 197, 94, 0.12)',
            border: 'rgba(34, 197, 94, 0.35)',
            fg: 'rgb(21, 128, 61)',
            title: t('maintenance.banner.recovered_title', 'Update installed'),
            body: t('maintenance.banner.recovered_body', 'This tab is still on the previous version — reload to switch. Until then some things may look stale or misbehave.'),
        },
    }[phase];

    if (!style) return null;
    const { Icon, spin, bg, border, fg, title, body } = style;

    return (
        <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 px-4 py-2 text-xs border-b"
            style={{ background: bg, borderColor: border, color: fg }}
        >
            <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${spin ? 'animate-spin' : ''}`} />
            <div className="min-w-0">
                <span className="font-semibold">{title}</span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span>{body}</span>
            </div>
            {phase === 'recovered' && (
                <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="ml-auto shrink-0 underline font-medium"
                >
                    {t('maintenance.banner.reload', 'Reload')}
                </button>
            )}
        </div>
    );
}
