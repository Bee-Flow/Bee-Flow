import React, { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { openMicrosoftOAuthPopup, type MicrosoftOAuthError } from '../../lib/microsoftOAuthPopup';
import {
    type Microsoft365Status,
    useDisconnectMicrosoft365,
    useInvalidateMicrosoft365,
    useMicrosoft365Status,
} from '../../api/queries/microsoft365';
import { API_BASE, authFetch } from '../../utils/helpers';
// Circular on purpose, like SimpleApiKeyIntegration: the shared row
// primitives are only read at render time.
import { IntegrationRow, DisconnectButton } from './IntegrationsSection';

const MicrosoftLogo = () => (
    <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
        <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
        <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
        <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
        <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
);

type T = ReturnType<typeof useTranslation>['t'];

function describe(status: Microsoft365Status | null, t: T): string {
    if (!status) return '…';
    if (status.connected) {
        return status.email
            ? t('integ.microsoft_connected_as', { email: status.email })
            : t('integ.microsoft_connected', 'Connected — Outlook works in chat and automations');
    }
    if (status.needsReauth) {
        return t('integ.microsoft_needs_reauth', 'Your Microsoft connection expired — reconnect to keep tools and automations working');
    }
    return t('integ.microsoft_desc', 'Connect Outlook so AI tools and automations can read and send your Microsoft 365 mail');
}

interface TileBodyProps {
    status: Microsoft365Status | null;
    connecting: boolean;
    disconnecting: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
    t: T;
}

function TileBody({ status, connecting, disconnecting, onConnect, onDisconnect, t }: TileBodyProps) {
    if (!status) return <p className="text-[12px] text-[var(--text-muted)]">…</p>;
    if (!status.configured) {
        return (
            <p className="text-[12px] text-[var(--text-muted)]">
                {t('integ.microsoft_not_configured', 'Microsoft 365 is not configured. Ask your admin to set the Microsoft Client ID and Secret in Admin → Authentication.')}
            </p>
        );
    }
    if (status.connected && status.viaSso) {
        return (
            <p className="text-[11px] text-[var(--text-muted)]">
                {t('integ.microsoft_via_sso_note', 'Connected through your Microsoft sign-in. Sign out to end it.')}
            </p>
        );
    }
    if (status.connected) {
        return (
            <div className="space-y-2">
                <p className="text-[11px] text-[var(--text-muted)]">
                    {t('integ.microsoft_disconnect_note', 'Disconnecting pauses automations that use Outlook until you reconnect. You stay signed in.')}
                </p>
                <DisconnectButton onDisconnect={onDisconnect} disconnecting={disconnecting} t={t} />
            </div>
        );
    }
    const needsReauth = !!status.needsReauth;
    let label = t('integ.microsoft_connect', 'Connect Microsoft 365');
    if (connecting) label = t('integ.microsoft_opening', 'Opening Microsoft…');
    else if (needsReauth) label = t('integ.microsoft_reconnect', 'Reconnect');
    return (
        <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className={`px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-50 ${needsReauth ? 'bg-[#d97706]' : 'bg-[#0078d4]'}`}
        >
            {label}
        </button>
    );
}

/**
 * Settings → Integrations → Microsoft 365: connect Outlook through
 * /api/integrations/microsoft (the vault connector), for users who did not log
 * in with Microsoft. That is how a Google-SSO or password user gets Outlook
 * into chat and scheduled agent runs: the server lifts the Outlook tools off the
 * vault credential next to whatever session they have. Microsoft-SSO users see
 * it connected already. Mirrors the Google Workspace tile.
 */
export default function Microsoft365Integration({ onSaved, last = false }: { onSaved: () => void; last?: boolean }) {
    const { t } = useTranslation();
    const statusQuery = useMicrosoft365Status();
    const invalidate = useInvalidateMicrosoft365();
    const disconnect = useDisconnectMicrosoft365();
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');
    // A status that could not be read renders as "not configured", the same
    // answer the Google tile gives.
    const status: Microsoft365Status | null = statusQuery.isPending
        ? null
        : (statusQuery.data || { configured: false, connected: false });
    const genericError = () => t('integ.microsoft_error', 'Could not start the Microsoft connection. Try again.');

    const handleConnect = async () => {
        setConnecting(true);
        setError('');
        try {
            await openMicrosoftOAuthPopup({
                authFetch,
                apiBase: API_BASE,
                onOpened: () => setConnecting(false),
                onDone: ({ success, closed }) => {
                    if (closed) return;
                    void invalidate();
                    if (success) onSaved();
                },
            });
        } catch (e) {
            const err = e as MicrosoftOAuthError;
            setError(err?.code === 'popup_blocked'
                ? t('integ.microsoft_popup_blocked', 'The Microsoft sign-in popup was blocked — allow popups for this site and try again.')
                : (err?.message || genericError()));
            setConnecting(false);
        }
    };

    const handleDisconnect = () => {
        setError('');
        disconnect.mutate(undefined, {
            onSuccess: () => onSaved(),
            onError: (e) => setError(e.message || genericError()),
        });
    };

    return (
        <IntegrationRow
            last={last}
            connected={!!status?.connected}
            badge={null}
            name="Microsoft 365"
            description={describe(status, t)}
            icon={<MicrosoftLogo />}
        >
            <TileBody
                status={status}
                connecting={connecting}
                disconnecting={disconnect.isPending}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                t={t}
            />
            {error && <p className="text-[11px] mt-2 text-[#dc2626]">{error}</p>}
        </IntegrationRow>
    );
}

const MICROSOFT_APP_IDS = ['outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts'];

/**
 * The Microsoft 365 group on the Integrations page: shown whenever at least
 * one Microsoft app is in the organisation's effective entitlement set, the
 * same rule the Google Workspace group follows.
 */
export function Microsoft365Group({ isEnabled, onSaved }: { isEnabled: (id: string) => boolean; onSaved: () => void }) {
    const { t } = useTranslation();
    if (!MICROSOFT_APP_IDS.some(isEnabled)) return null;
    return (
        <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2 text-[var(--text-muted)]">
                {t('integ.microsoft_group', 'Microsoft 365')}
            </p>
            <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)]">
                <Microsoft365Integration onSaved={onSaved} last />
            </div>
        </div>
    );
}
