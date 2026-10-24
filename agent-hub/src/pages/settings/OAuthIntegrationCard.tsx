import type { ReactNode } from 'react';
import { IntegrationRow, DisconnectButton } from './IntegrationPrimitives';

// The shared body of an OAuth-popup integration row (Google Workspace,
// Withings, LinkedIn): loading dots, "not configured", connected (note +
// disconnect) or the brand-coloured connect button. The wrappers own the
// provider's wording and popup; this owns the layout.
export interface OAuthIntegrationCardProps {
    last: boolean;
    name: string;
    icon: ReactNode;
    badge?: ReactNode;
    description: string;
    loading: boolean;
    configured: boolean;
    connected: boolean;
    needsReauth?: boolean;
    notConfiguredText: string;
    /** Small note above the disconnect button. */
    disconnectNote?: string;
    /** Extra block above the note while connected (Google's re-authorize prompt). */
    connectedExtra?: ReactNode;
    connectLabel: string;
    brandColor: string;
    connecting: boolean;
    disconnecting: boolean;
    error?: string;
    /** 'independent': a connected row shows its disconnect even when not configured. */
    layout?: 'exclusive' | 'independent';
    onConnect: () => void;
    onDisconnect: () => void;
}

const RECONNECT_COLOR = '#d97706';

export function OAuthIntegrationCard(p: OAuthIntegrationCardProps) {
    const independent = p.layout === 'independent';
    const connectedBody = (p.disconnectNote || p.connectedExtra) ? (
        <div className="space-y-2">
            {p.connectedExtra}
            {p.disconnectNote && <p className="text-[11px] text-[var(--text-muted)]">{p.disconnectNote}</p>}
            <DisconnectButton onDisconnect={p.onDisconnect} disconnecting={p.disconnecting} />
        </div>
    ) : <DisconnectButton onDisconnect={p.onDisconnect} disconnecting={p.disconnecting} />;
    const connectButton = (
        <button
            type="button"
            onClick={p.onConnect}
            disabled={p.connecting}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-50"
            style={{ background: p.needsReauth ? RECONNECT_COLOR : p.brandColor }}
        >
            {p.connectLabel}
        </button>
    );
    return (
        <IntegrationRow last={p.last} connected={p.connected} badge={p.badge} name={p.name} description={p.description} icon={p.icon}>
            {p.loading ? (
                <p className="text-[12px] text-[var(--text-muted)]">…</p>
            ) : independent ? (
                <>
                    {!p.configured && <p className="text-[12px] text-[var(--text-muted)]">{p.notConfiguredText}</p>}
                    {p.configured && !p.connected && connectButton}
                    {p.connected && connectedBody}
                </>
            ) : !p.configured ? (
                <p className="text-[12px] text-[var(--text-muted)]">{p.notConfiguredText}</p>
            ) : p.connected ? connectedBody : connectButton}
            {p.error && <p className="text-[11px] mt-2 [color:#dc2626]!">{p.error}</p>}
        </IntegrationRow>
    );
}
