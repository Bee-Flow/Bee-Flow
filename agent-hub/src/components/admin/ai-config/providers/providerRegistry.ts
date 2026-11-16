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

/** What a provider serves: language models (chat, embeddings, rerank), or speech and media only. */
export type ProviderGroup = 'language' | 'media';

export interface ProviderEntry {
    id: string;
    name: string;
    icon: string;
    iconClass: string;
    kind: ProviderKind;
    group: ProviderGroup;
    keyConfig?: ProviderKeyConfig;
    /** Is this provider usable, from the has-flags of GET /ai/config? */
    isConnected: (config: AiConfigBag) => boolean;
}

/** The avatar chip of every provider: one neutral surface, no brand tints. */
export const PROVIDER_ICON_CLASS = 'bg-[var(--bg-secondary)]';

const keyProvider = (id: string, group: ProviderGroup = 'language'): ProviderEntry => {
    const keyConfig = PROVIDER_KEY_CONFIGS[id];
    return {
        id,
        name: keyConfig.name,
        icon: keyConfig.icon,
        iconClass: PROVIDER_ICON_CLASS,
        kind: 'apiKey',
        group,
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
    keyProvider('elevenlabs', 'media'),
    {
        id: 'vertex',
        name: 'Google Vertex',
        icon: '☁️',
        iconClass: PROVIDER_ICON_CLASS,
        kind: 'custom',
        group: 'language',
        isConnected: (config) => !!config?.hasGoogleVertexProject && !!config?.hasGoogleVertexServiceAccountKey,
    },
    {
        id: 'azure',
        name: 'Azure',
        icon: '🔷',
        iconClass: PROVIDER_ICON_CLASS,
        kind: 'custom',
        group: 'language',
        isConnected: (config) => !!config?.hasAzureEndpoint && !!config?.hasAzureApiKey,
    },
];

/**
 * Pane ids that are not a registry provider. A local runtime is `local-<provider id>`.
 * The reranker that had a pane here (`reranker`) lives on Search & retrieval now.
 */
export const RERANKER_ID = 'reranker';
export const ADD_LOCAL_ID = 'add-local';
const LOCAL_PREFIX = 'local-';

export const localPaneId = (providerId: string) => `${LOCAL_PREFIX}${providerId}`;

export const findProvider = (id: string | null | undefined) => PROVIDER_REGISTRY.find((p) => p.id === id);

/**
 * Which pane to show: the one the URL names when it is real, else the first
 * connected provider, else none (the picker). A local runtime is looked up in
 * the connected ones, so a link to a runtime that is gone falls back too.
 */
export function resolveSelection(urlId: string | undefined, localProviders: RuntimeProvider[], connectedIds: ReadonlySet<string>) {
    const localProvider = urlId?.startsWith(LOCAL_PREFIX) ? localProviders.find(p => localPaneId(p.id) === urlId) : undefined;
    const isReal = !!findProvider(urlId) || urlId === ADD_LOCAL_ID || !!localProvider;
    if (urlId && isReal) return { selectedId: urlId, localProvider };
    const firstConnected = PROVIDER_REGISTRY.find(e => connectedIds.has(e.id));
    return { selectedId: firstConnected?.id ?? null, localProvider: undefined };
}
