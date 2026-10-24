import React, { useState } from 'react';
import { OAuthIntegrationCard } from './OAuthIntegrationCard';
import { useTranslation } from '../../hooks/useTranslation';
import { getIntegrationIcon } from '../../config/integrationIcons';
import { openGoogleOAuthPopup } from '../../lib/googleOAuthPopup';
import { API_BASE, authFetch } from '../../utils/helpers';
import { openOAuthWindow, useOAuthIntegration } from '../../api/queries/oauthIntegration';
import type { GoogleWorkspaceIntegrationProps, LinkedInIntegrationProps, WithingsIntegrationProps } from './IntegrationsSection.types';

// The three OAuth-popup rows of Settings → Connections. The status read, the
// auth-url read, the disconnect and the popup callback live in
// api/queries/oauthIntegration; the row layout in OAuthIntegrationCard. What is
// left here is each provider's wording and its popup.

// ── Google Workspace ──────────────────────────────────────────────────────────
// BFSF-255: manual connect for Gmail/Calendar/Drive & co. Email/password
// accounts never go through Google-SSO login, so without this tile the whole
// Google toolset was silently dead for them; SSO users also had no way to see
// or revoke their authorisation. The popup + postMessage flow lives in
// lib/googleOAuthPopup (shared with the Meeting Notes surfaces); lazy status
// fetch (GitHub).
export const GoogleWorkspaceIntegration = ({ onSaved, last }: GoogleWorkspaceIntegrationProps) => {
    const { t } = useTranslation();
    const oauth = useOAuthIntegration('google', { onSaved });
    const { status } = oauth;
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');

    const handleConnect = async () => {
        setConnecting(true); setError('');
        try {
            await openGoogleOAuthPopup({
                authFetch,
                apiBase: API_BASE,
                onOpened: () => setConnecting(false),
                onDone: ({ success, closed }) => {
                    if (closed) return;
                    oauth.refresh();
                    if (success) onSaved();
                },
            });
        } catch (e) {
            setError((e as Error)?.message || t('integ.google_error', 'Could not start the Google connection. Try again.'));
            setConnecting(false);
        }
    };
    const handleDisconnect = () => { setError(''); oauth.disconnect(); };

    const loading = status === null;
    const connected = !!status?.connected;
    const needsReauth = !loading && !connected && !!status?.needsReauth;
    // Connected before the Meet scopes were added to the connector — the token
    // works for Gmail/Calendar/Drive but Meeting Notes can't read Meet
    // recordings until the user re-consents (incremental: existing grants stay).
    const needsMeetReconsent = connected && status?.meetScopesGranted === false;
    return (
        <OAuthIntegrationCard
            last={last}
            name="Google Workspace"
            icon={<svg viewBox="0 0 24 24" className="w-[20px] h-[20px]" aria-hidden="true"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" /><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" /><path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" /><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" /></svg>}
            badge={needsMeetReconsent ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning-ink)]">
                    {t('integ.google_update_needed', 'Update needed')}
                </span>
            ) : null}
            description={loading
                ? '…'
                : connected
                    ? (status?.email ? t('integ.google_connected_as', { email: status.email }) : t('integ.google_connected'))
                    : needsReauth
                        ? t('integ.google_needs_reauth')
                        : t('integ.google_desc')}
            loading={loading}
            configured={!!status?.configured}
            connected={connected}
            needsReauth={needsReauth}
            notConfiguredText={t('integ.google_not_configured')}
            disconnectNote={t('integ.google_disconnect_note')}
            connectedExtra={needsMeetReconsent && (
                <div className="rounded-lg px-3 py-2.5 border bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] border-[color-mix(in_srgb,var(--warning)_35%,transparent)]">
                    <p className="text-[11px] text-[var(--warning-ink)]">
                        {t('integ.google_meet_scope_missing', 'Meeting Notes needs extra Google Meet permissions to import your meeting recordings — re-authorize to grant them. Your existing Gmail, Calendar and Drive access is kept.')}
                    </p>
                    <button
                        type="button"
                        onClick={handleConnect}
                        disabled={connecting}
                        className="mt-2 px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-50 bg-[var(--warning)] text-[var(--accent-primary-fg)]"
                    >
                        {connecting ? t('integ.google_opening', 'Opening Google…') : t('integ.google_reauthorize', 'Re-authorize Google')}
                    </button>
                </div>
            )}
            connectLabel={connecting
                ? t('integ.google_opening', 'Opening Google…')
                : needsReauth ? t('integ.google_reconnect') : t('integ.google_connect')}
            brandColor="#4285F4"
            connecting={connecting}
            disconnecting={oauth.disconnecting}
            error={error}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
        />
    );
};

// ── LinkedIn ──────────────────────────────────────────────────────────────────
// Its status arrives as props off the shared `statuses` blob, so no read here.
export const LinkedInIntegration = ({ connected, linkedInName, hasLinkedInConfig, onSaved, last }: LinkedInIntegrationProps) => {
    const { t } = useTranslation();
    const oauth = useOAuthIntegration('linkedin', { remoteStatus: false, callbackType: 'linkedin-callback', onSaved });
    const [connecting, setConnecting] = useState(false);
    const handleConnect = async () => {
        setConnecting(true);
        try { // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- logs to the browser console of the person who clicked; nothing is sent to a client
            const res = await oauth.fetchAuthUrl();
            if (res.ok) {
                const { url } = await res.json();
                openOAuthWindow(url, 'linkedin-oauth', 600, 700);
            }
        } catch (e) { console.error(e); }
        setConnecting(false);
    };
    return (
        <OAuthIntegrationCard
            last={last}
            name="LinkedIn"
            icon={<svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="#0A66C2" /><path d="M7.5 9.5h2v7h-2v-7zm1-3.2a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4zm3.5 3.2h1.9v1h0c.27-.5.92-1.1 1.9-1.1 2 0 2.4 1.3 2.4 3.1v3.6h-2v-3.2c0-.8 0-1.8-1.1-1.8s-1.3.9-1.3 1.7v3.3h-2v-6.6z" fill="white" /></svg>}
            description={connected ? (linkedInName ? t('integ.linkedin_connected_as', { name: linkedInName }) : t('integ.linkedin_connected')) : t('integ.linkedin_desc')}
            loading={false}
            configured={!!hasLinkedInConfig}
            connected={!!connected}
            notConfiguredText={t('integ.linkedin_not_configured')}
            connectLabel={connecting ? t('integ.linkedin_opening') : t('integ.linkedin_connect')}
            brandColor="#0A66C2"
            connecting={connecting}
            disconnecting={oauth.disconnecting}
            layout="independent"
            onConnect={handleConnect}
            onDisconnect={oauth.disconnect}
        />
    );
};

// ── Withings ──────────────────────────────────────────────────────────────────
// Self-fetching status (the Google Workspace pattern) rather than a prop off the
// shared `statuses` blob: the vault row is the only truth about whether this is
// connected, and it changes from a popup this component owns.
export const WithingsIntegration = ({ onSaved, last }: WithingsIntegrationProps) => {
    const { t } = useTranslation();
    const oauth = useOAuthIntegration('withings', { callbackType: 'withings-callback', refreshOnCallback: true, onSaved });
    const { status } = oauth;
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');

    const handleConnect = async () => {
        setConnecting(true); setError('');
        try {
            const res = await oauth.fetchAuthUrl();
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.url) throw new Error(data.error || 'Could not start the Withings connection.');
            openOAuthWindow(data.url, 'withings-oauth', 600, 760);
        } catch (e) {
            setError((e as Error)?.message || t('integ.withings_error', 'Could not start the Withings connection. Try again.'));
        }
        setConnecting(false);
    };
    const handleDisconnect = () => { setError(''); oauth.disconnect(); };

    const loading = status === null;
    const connected = !!status?.connected;
    const needsReauth = !loading && !connected && !!status?.needsReauth;

    return (
        <OAuthIntegrationCard
            last={last}
            name="Withings"
            icon={getIntegrationIcon('withings')}
            description={loading
                ? '…'
                : connected
                    ? (status?.withingsUserId
                        ? t('integ.withings_connected_as', { id: status.withingsUserId })
                        : t('integ.withings_connected'))
                    : needsReauth
                        ? t('integ.withings_needs_reauth')
                        : t('integ.withings_desc')}
            loading={loading}
            configured={!!status?.configured}
            connected={connected}
            needsReauth={needsReauth}
            notConfiguredText={t('integ.withings_not_configured')}
            disconnectNote={t('integ.withings_disconnect_note')}
            connectLabel={connecting
                ? t('integ.withings_opening')
                : needsReauth ? t('integ.withings_reconnect') : t('integ.withings_connect')}
            brandColor="#00A9A6"
            connecting={connecting}
            disconnecting={oauth.disconnecting}
            error={error}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
        />
    );
};
