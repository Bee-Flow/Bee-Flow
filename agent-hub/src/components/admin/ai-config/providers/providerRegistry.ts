// The one list of cloud providers the AI configuration knows. `name` must equal
// the providerName the backend stamps on that provider's models
// (GET /ai/providers), because the model list of a provider is matched on it.
//
//   apiKey - one secret key, handled by ApiKeyDetail (config in providerKeyConfig.ts)
//   custom - its own form (Azure, Google Vertex)
//
// Self-hosted runtimes are not here: a customer can connect several under names
// they choose, so they come from the backend, not from this list.

import { PROVIDER_KEY_CONFIGS } from '../ProviderCards/providerKeyConfig';
import type { ProviderKeyConfig } from '../ProviderCards/providerKeyConfig';
import type { AiConfigBag } from './types';
import type { RuntimeProvider } from '@/api/runtimeTypes';

type ProviderKind = 'apiKey' | 'custom';

export interface ProviderEntry {
    id: string;
    name: string;
    icon: string;
    iconClass: string;
    kind: ProviderKind;
    keyConfig?: ProviderKeyConfig;
    /** Is this provider usable, from the has-flags of GET /ai/config? */
    isConnected: (config: AiConfigBag) => boolean;
}

const keyProvider = (id: string): ProviderEntry => {
    const keyConfig = PROVIDER_KEY_CONFIGS[id];
    return {
        id,
        name: keyConfig.name,
        icon: keyConfig.icon,
        iconClass: keyConfig.iconClass,
        kind: 'apiKey',
        keyConfig,
        isConnected: (config) => !!config?.[keyConfig.statusField],
    };
};

export const PROVIDER_REGISTRY: ProviderEntry[] = [
    keyProvider('mistral'),
    keyProvider('openai'),
    keyProvider('claude'),
    keyProvider('google'),
    keyProvider('scaleway'),
    keyProvider('eugpt'),
    keyProvider('ionos'),
    keyProvider('elevenlabs'),
    {
        id: 'vertex',
        name: 'Google Vertex',
        icon: '☁️',
        iconClass: '[background:linear-gradient(135deg,rgba(66,133,244,0.2),rgba(52,168,83,0.2))]',
        kind: 'custom',
        isConnected: (config) => !!config?.hasGoogleVertexProject && !!config?.hasGoogleVertexServiceAccountKey,
    },
    {
        id: 'azure',
        name: 'Azure',
        icon: '🔷',
        iconClass: '[background:linear-gradient(135deg,rgba(0,120,212,0.2),rgba(0,153,255,0.2))]',
        kind: 'custom',
        isConnected: (config) => !!config?.hasAzureEndpoint && !!config?.hasAzureApiKey,
    },
];

/** Pane ids that are not a registry provider. A local runtime is `local-<provider id>`. */
export const RERANKER_ID = 'reranker';
export const ADD_LOCAL_ID = 'add-local';
const LOCAL_PREFIX = 'local-';

export const localPaneId = (providerId: string) => `${LOCAL_PREFIX}${providerId}`;

/** A reranker is set up through a provider (rerank tier) or through Azure Cohere (endpoint and key). */
export const rerankerConnected = (config: AiConfigBag) =>
    (!!config?.rerankProviderId && !!config?.rerankModel) || (!!config?.hasAzureRerankerEndpoint && !!config?.hasAzureRerankerKey);

export const findProvider = (id: string | null | undefined) => PROVIDER_REGISTRY.find((p) => p.id === id);

/**
 * Which pane to show: the one the URL names when it is real, else the first
 * connected provider, else none (the picker). A local runtime is looked up in
 * the connected ones, so a link to a runtime that is gone falls back too.
 */
export function resolveSelection(urlId: string | undefined, localProviders: RuntimeProvider[], connectedIds: ReadonlySet<string>) {
    const localProvider = urlId?.startsWith(LOCAL_PREFIX) ? localProviders.find(p => localPaneId(p.id) === urlId) : undefined;
    const isReal = !!findProvider(urlId) || urlId === RERANKER_ID || urlId === ADD_LOCAL_ID || !!localProvider;
    if (urlId && isReal) return { selectedId: urlId, localProvider };
    const firstConnected = PROVIDER_REGISTRY.find(e => connectedIds.has(e.id));
    return { selectedId: firstConnected?.id ?? null, localProvider: undefined };
}
