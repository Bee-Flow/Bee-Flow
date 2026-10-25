// One OAuth-popup integration (Google Workspace, Withings, LinkedIn): the
// status read, the auth-url read, the disconnect and the popup's postMessage
// callback, shared by the three Settings → Connections cards that used to
// each hand-write them.
//
// The status goes through `authFetch` inside queryFn (not `apiClient`): a
// non-ok answer or a network failure is a STATE the card renders as "not
// configured", never an exception, exactly like the effect it replaces.
// `status === null` means "still loading" (the card shows its skeleton).

import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { isTrustedOAuthOrigin } from '../../lib/oauthMessageOrigin';
import { mutate } from '../mutate';

export type OAuthProvider = 'google' | 'withings' | 'linkedin';

export interface OAuthStatus {
    configured: boolean;
    connected: boolean;
    needsReauth?: boolean;
    email?: string;
    meetScopesGranted?: boolean;
    withingsUserId?: string;
}

const NOT_CONNECTED: OAuthStatus = { configured: false, connected: false };

const oauthIntegrationKeys = {
    status: (provider: OAuthProvider) => ['oauth-integration', provider, 'status'] as const,
};

interface Options {
    /** false: the caller already knows the status (LinkedIn gets it as props), so no read is made. */
    remoteStatus?: boolean;
    /** `type` of the popup's postMessage; the message is only honoured from a trusted origin. */
    callbackType?: string;
    /** Re-read the status when the callback message arrives. */
    refreshOnCallback?: boolean;
    onSaved: () => void;
}

/** Open the provider's consent page centred on screen. */
export function openOAuthWindow(url: string, name: string, width: number, height: number): void {
    window.open(url, name, `width=${width},height=${height},left=${(screen.width - width) / 2},top=${(screen.height - height) / 2}`);
}

export function useOAuthIntegration(provider: OAuthProvider, { remoteStatus = true, callbackType, refreshOnCallback = false, onSaved }: Options) {
    const queryClient = useQueryClient();
    const base = `${API_BASE}/api/integrations/${provider}`;

    const query = useQuery<OAuthStatus, Error>({
        queryKey: oauthIntegrationKeys.status(provider),
        enabled: remoteStatus,
        queryFn: async () => {
            try {
                const res = await authFetch(`${base}/status`);
                return res.ok ? await res.json() : NOT_CONNECTED;
            } catch {
                return NOT_CONNECTED;
            }
        },
        staleTime: 0,
        retry: false,
    });
    const status: OAuthStatus | null = remoteStatus ? (query.data ?? null) : null;

    const refresh = React.useCallback(
        () => queryClient.invalidateQueries({ queryKey: oauthIntegrationKeys.status(provider) }),
        [queryClient, provider],
    );

    React.useEffect(() => {
        if (!callbackType) return;
        const handler = (e: MessageEvent) => {
            if (!isTrustedOAuthOrigin(e.origin, API_BASE)) return;
            if (e.data?.type !== callbackType) return;
            if (refreshOnCallback) refresh();
            if (e.data.success) onSaved();
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [callbackType, refreshOnCallback, refresh, onSaved]);

    /** GET auth-url; the caller reads the Response (each card reports a failure its own way). */
    const fetchAuthUrl = React.useCallback(() => authFetch(`${base}/auth-url`), [base]);

    const disconnectMutation = useMutation({
        mutationFn: () => mutate(`${base}/disconnect`, { method: 'POST' }),
        onSuccess: () => refresh(),
    });
    const disconnect = async () => {
        try { // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- logs to the browser console of the person who clicked; nothing is sent to a client
            await disconnectMutation.mutateAsync();
            onSaved();
        } catch (e) { console.error(e); }
    };

    return { status, refresh, fetchAuthUrl, disconnect, disconnecting: disconnectMutation.isPending };
}
