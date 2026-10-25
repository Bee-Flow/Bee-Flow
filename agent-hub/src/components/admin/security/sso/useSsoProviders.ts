import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { logger } from '../../../../utils/logger';
import { request, RefusedError } from '../../../../api/mutate';

export type SsoProviderId = 'nextcloud' | 'google' | 'microsoft';

/** One provider as GET /auth/providers returns it; the secret itself never comes back. */
export interface SsoProviderConfig {
    enabled: boolean;
    clientId: string;
    clientSecretSet: boolean;
    /** Nextcloud only. */
    url?: string;
    /** Microsoft only: a directory GUID or common/organizations/consumers. */
    tenantId?: string;
}

type SsoProviders = Record<SsoProviderId, SsoProviderConfig>;

/** A secret typed in the form, sent once and then cleared. */
type SsoSecrets = Record<SsoProviderId, string>;

interface SsoMessage {
    type: 'success' | 'error';
    text: string;
}

export interface SsoProvidersState {
    providers: SsoProviders;
    secrets: SsoSecrets;
    setSecrets: Dispatch<SetStateAction<SsoSecrets>>;
    loading: boolean;
    saving: Partial<Record<SsoProviderId, boolean>>;
    testing: Partial<Record<SsoProviderId, boolean>>;
    message: SsoMessage | null;
    setMessage: Dispatch<SetStateAction<SsoMessage | null>>;
    /** Base URL for the OAuth redirect URIs the instructions show. */
    redirectBase: string;
    handleSaveProvider: (provider: SsoProviderId) => Promise<void>;
    handleTestProvider: (provider: SsoProviderId) => Promise<void>;
    updateProviderField: (provider: SsoProviderId, field: keyof SsoProviderConfig, value: string) => void;
}

const INITIAL_PROVIDERS: SsoProviders = {
    nextcloud: { enabled: false, url: '', clientId: '', clientSecretSet: false },
    google: { enabled: false, clientId: '', clientSecretSet: false },
    microsoft: { enabled: false, clientId: '', clientSecretSet: false, tenantId: 'common' }
};

/** The PUT body for one provider: only its own fields, and the secret only when one was typed. */
function providerBody(provider: SsoProviderId, config: SsoProviderConfig, secret: string): Record<string, string | undefined> {
    const body: Record<string, string | undefined> = {};
    if (provider === 'nextcloud') {
        body.url = config.url;
        body.clientId = config.clientId;
    } else if (provider === 'google') {
        body.clientId = config.clientId;
    } else if (provider === 'microsoft') {
        body.clientId = config.clientId;
        body.tenantId = config.tenantId;
    }
    if (secret) body.clientSecret = secret;
    return body;
}

/** The server's public URL, for the redirect URI instructions ('' until known). */
function useServerUrl(): string {
    const [serverUrl, setServerUrl] = useState('');
    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/auth/setup-status`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.serverUrl) setServerUrl(data.serverUrl);
                }
            } catch (err) { logger.debug('setup status unavailable, server URL stays unset', err); }
        })();
    }, []);
    return serverUrl;
}

/** The SSO providers' configuration: load, edit, save and test. */
export default function useSsoProviders(): SsoProvidersState {
    const [providers, setProviders] = useState<SsoProviders>(INITIAL_PROVIDERS);
    const [secrets, setSecrets] = useState<SsoSecrets>({ nextcloud: '', google: '', microsoft: '' });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<Partial<Record<SsoProviderId, boolean>>>({});
    const [testing, setTesting] = useState<Partial<Record<SsoProviderId, boolean>>>({});
    const [message, setMessage] = useState<SsoMessage | null>(null);
    const serverUrl = useServerUrl();

    const fetchProviders = async () => {
        try {
            const res = await request(`${API_BASE}/auth/providers`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                setProviders(data);
            }
        } catch (e) {
            console.error('Failed to fetch providers:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchProviders();
    }, []);

    const handleSaveProvider = async (provider: SsoProviderId) => {
        setSaving(prev => ({ ...prev, [provider]: true }));
        setMessage(null);

        try {
            const res = await authFetch(`${API_BASE}/auth/providers/${provider}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(providerBody(provider, providers[provider], secrets[provider]))
            });

            const data = await res.json();
            if (res.ok) {
                setMessage({ type: 'success', text: data.message });
                setSecrets(prev => ({ ...prev, [provider]: '' }));
                fetchProviders();
            } else {
                setMessage({ type: 'error', text: data.error });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save configuration' });
        } finally {
            setSaving(prev => ({ ...prev, [provider]: false }));
        }
    };

    const handleTestProvider = async (provider: SsoProviderId) => {
        setTesting(prev => ({ ...prev, [provider]: true }));
        setMessage(null);

        try {
            const res = await authFetch(`${API_BASE}/auth/providers/${provider}/test`, {
                method: 'POST',
            });
            const data = await res.json();
            setMessage({ type: res.ok ? 'success' : 'error', text: res.ok ? data.message : data.error });
        } catch (e) {
            setMessage({ type: 'error', text: 'Connection test failed' });
        } finally {
            setTesting(prev => ({ ...prev, [provider]: false }));
        }
    };

    const updateProviderField = (provider: SsoProviderId, field: keyof SsoProviderConfig, value: string) => {
        setProviders(prev => ({
            ...prev,
            [provider]: { ...prev[provider], [field]: value }
        }));
    };

    return {
        providers, secrets, setSecrets, loading, saving, testing, message, setMessage,
        redirectBase: serverUrl || API_BASE,
        handleSaveProvider, handleTestProvider, updateProviderField,
    };
}
