import { AlertCircle } from 'lucide-react';

const BANNER = 'mx-3 mb-2 flex items-center gap-2 px-3 py-2 rounded-lg border text-[11px] bg-[color-mix(in_srgb,var(--warning)_8%,var(--bg-secondary))] border-[var(--warning)] text-[var(--text-primary)]';
const BUTTON = 'px-2 py-1 rounded-lg text-[11px] font-medium border disabled:opacity-50 flex-shrink-0 border-[var(--warning)] text-[var(--warning-ink)]';

interface ReconnectBannerProps {
    text: string;
    buttonLabel: string;
    busyLabel: string;
    busy: boolean;
    onReconnect: () => void;
    testId?: string;
}

/**
 * The Upcoming panel's warning line for a provider account that only a
 * reconnect can help: the grant expired, or it lacks the meeting permissions.
 */
export default function ReconnectBanner({ text, buttonLabel, busyLabel, busy, onReconnect, testId }: ReconnectBannerProps) {
    return (
        <div className={BANNER} data-testid={testId}>
            <AlertCircle className="w-4 h-4 flex-shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span className="flex-1">{text}</span>
            <button type="button" onClick={onReconnect} disabled={busy} className={BUTTON}>
                {busy ? busyLabel : buttonLabel}
            </button>
        </div>
    );
}
