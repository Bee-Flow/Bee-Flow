import { Video, Loader2 } from 'lucide-react';
import { errorMessage } from '@/utils/caughtError';

const PANEL = 'rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]';
const PRIMARY_BTN = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]';

/** The provider's tile colour, from the theme (never a brand hex). */
export const RECONNECT_TILE = {
    teams: 'bg-[color-mix(in_srgb,var(--accent-secondary)_12%,transparent)] text-[var(--accent-secondary)]',
    gmeet: 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]',
} as const;

interface ReconnectCardProps {
    title: string;
    description: string;
    buttonLabel: string;
    tile: keyof typeof RECONNECT_TILE;
    reauthError: unknown;
    reauthBusy: boolean;
    onReauthorize: () => void;
    testId?: string;
}

/**
 * Shown by a meeting import panel instead of its list when only a reconnect
 * of the provider account can help: the grant expired, or it predates the
 * meeting permissions.
 */
export default function ReconnectCard({ title, description, buttonLabel, tile, reauthError, reauthBusy, onReauthorize, testId }: ReconnectCardProps) {
    return (
        <div className={`flex flex-col items-center gap-3 px-4 py-10 text-center ${PANEL}`} data-testid={testId}>
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${RECONNECT_TILE[tile]}`}>
                <Video className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">{title}</div>
            <div className="text-xs max-w-sm text-[var(--text-muted)]">{description}</div>
            {Boolean(reauthError) && <div className="text-xs text-[var(--error)]">{errorMessage(reauthError)}</div>}
            <button type="button" onClick={onReauthorize} disabled={reauthBusy} className={PRIMARY_BTN}>
                {reauthBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {buttonLabel}
            </button>
        </div>
    );
}
