import { useMemo, useState } from 'react';
import { useServerUrlQuery, useSsoProvidersQuery } from '@/api/queries/adminConfigReads';
import type { Dispatch, SetStateAction } from 'react';
import { API_BASE } from '@/utils/helpers';
import { settled } from '@/api/settled';

export type SsoProviderId = 'nextcloud' | 'google' | 'microsoft';

/** One additional Microsoft tenant: its own app registration and its own login button. */
export interface MicrosoftConnection {
    id: string;
    label: string;
    logo: string;
    clientId: string;
    tenantId: string;
    clientSecretSet: boolean;
}

/** A client-side id for a connection that is not saved yet; the server keeps whatever id it gets. */
export function newConnectionId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One provider as GET /auth/providers returns it; the secret itself never comes back. */
export interface SsoProviderConfig {
    enabled: boolean;
    clientId: string;
    clientSecretSet: boolean;
    /** Nextcloud only. */
    url?: string;
    /** Microsoft only: a directory GUID or common/organizations/consumers. */
    tenantId?: string;
    /** Microsoft only: the login button's text; empty means "Sign in with Microsoft". */
    label?: string;
    /** Microsoft only: the login button's logo (data URL or https URL); empty means the Microsoft logo. */
    logo?: string;
    /** Microsoft only: the additional tenants. */
    connections?: MicrosoftConnection[];
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
    /** A client secret typed for an additional Microsoft connection, by connection id. */
    connectionSecrets: Record<string, string>;
    setConnectionSecret: (connectionId: string, secret: string) => void;
    /** Replace the additional Microsoft connections (an unsaved edit). */
    setConnections: (connections: MicrosoftConnection[]) => void;
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
    microsoft: { enabled: false, clientId: '', clientSecretSet: false, tenantId: 'common', label: '', logo: '', connections: [] }
};

/** The providers with the form's unsaved edits laid over them. */
function overlayEdits(base: SsoProviders, edits: Partial<Record<SsoProviderId, Partial<SsoProviderConfig>>>): SsoProviders {
    const ids = Object.keys(edits) as SsoProviderId[];
    if (ids.length === 0) return base;
    const next = { ...base };
    for (const id of ids) next[id] = { ...base[id], ...edits[id] };
    return next;
}

/** The PUT body for one provider: only its own fields, and the secret only when one was typed. */
function providerBody(provider: SsoProviderId, config: SsoProviderConfig, secret: string, connectionSecrets: Record<string, string> = {}): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (provider === 'nextcloud') {
        body.url = config.url;
        body.clientId = config.clientId;
    } else if (provider === 'google') {
        body.clientId = config.clientId;
    } else if (provider === 'microsoft') {
        body.clientId = config.clientId;
        body.tenantId = config.tenantId;
        body.label = config.label ?? '';
        body.logo = config.logo ?? '';
        body.connections = (config.connections ?? []).map(({ id, label, logo, clientId, tenantId }) => ({
            id, label, logo, clientId, tenantId,
            ...(connectionSecrets[id] ? { clientSecret: connectionSecrets[id] } : {}),
        }));
    }
    if (secret) body.clientSecret = secret;
    return body;
}

/** The SSO providers' configuration: load, edit, save and test. */
export default function useSsoProviders(): SsoProvidersState {
    const providersQuery = useSsoProvidersQuery<SsoProviders>();
    // The server's configuration with the edits typed since the last read laid over it.
    const [edits, setEdits] = useState<Partial<Record<SsoProviderId, Partial<SsoProviderConfig>>>>({});
    const providers = useMemo(() => overlayEdits(providersQuery.data ?? INITIAL_PROVIDERS, edits), [providersQuery.data, edits]);
    const [secrets, setSecrets] = useState<SsoSecrets>({ nextcloud: '', google: '', microsoft: '' });
    const [connectionSecrets, setConnectionSecrets] = useState<Record<string, string>>({});
    const loading = providersQuery.isPending;
    const [saving, setSaving] = useState<Partial<Record<SsoProviderId, boolean>>>({});
    const [testing, setTesting] = useState<Partial<Record<SsoProviderId, boolean>>>({});
    const [message, setMessage] = useState<SsoMessage | null>(null);
    const serverUrl = useServerUrlQuery().data;

    // Re-read the configuration; the edits are dropped with the old answer, as the form was refilled before.
    const { refetch } = providersQuery;
    const fetchProviders = async () => {
        await refetch();
        setEdits({});
    };

    const handleSaveProvider = async (provider: SsoProviderId) => {
        setSaving(prev => ({ ...prev, [provider]: true }));
        setMessage(null);

        try {
            const res = await settled(`${API_BASE}/auth/providers/${provider}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(providerBody(provider, providers[provider], secrets[provider], connectionSecrets))
            });

            const data = res.ok ? await res.res.json() : res.body;
            if (res.ok) {
                setMessage({ type: 'success', text: data.message });
                setSecrets(prev => ({ ...prev, [provider]: '' }));
                if (provider === 'microsoft') setConnectionSecrets({});
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
            const res = await settled(`${API_BASE}/auth/providers/${provider}/test`, {
                method: 'POST',
            });
            const data = res.ok ? await res.res.json() : res.body;
            setMessage({ type: res.ok ? 'success' : 'error', text: res.ok ? data.message : data.error });
        } catch (e) {
            setMessage({ type: 'error', text: 'Connection test failed' });
        } finally {
            setTesting(prev => ({ ...prev, [provider]: false }));
        }
    };

    const updateProviderField = (provider: SsoProviderId, field: keyof SsoProviderConfig, value: string) => {
        setEdits(prev => ({ ...prev, [provider]: { ...prev[provider], [field]: value } }));
    };

    const setConnectionSecret = (connectionId: string, secret: string) => {
        setConnectionSecrets(prev => ({ ...prev, [connectionId]: secret }));
    };
    const setConnections = (connections: MicrosoftConnection[]) => {
        setEdits(prev => ({ ...prev, microsoft: { ...prev.microsoft, connections } }));
    };

    return {
        providers, secrets, setSecrets, connectionSecrets, setConnectionSecret, setConnections,
        loading, saving, testing, message, setMessage,
        redirectBase: serverUrl || API_BASE,
        handleSaveProvider, handleTestProvider, updateProviderField,
    };
}
