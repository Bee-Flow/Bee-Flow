// The models the organisation Azure panel's Chat Model Tiers can pick from.
//
// The panel asked `GET /ai/models`, a route the server never had: the 404 left
// the list empty, so every self-hosted org admin saw "No models available"
// unless Azure deployment names were typed in by hand, even with Anthropic,
// OpenAI or Mistral connected. The tiers it writes (`chat_model_tiers`) are the
// same ones the admin dashboard fills from every provider, so the picker reads
// the same source: the providers, then each provider's model list.
import { getModelMeta } from '../../admin/ai-config/chatModelTiers/modelMeta';

type Fetcher = (url: string) => Promise<Response>;

export interface ProviderModel {
    id: string;
    name?: string;
    cat?: string;
    provider: string;
    providerId: string;
    providerName: string;
    providerType?: string;
    [key: string]: unknown;
}

interface Provider { id: string; name: string; type?: string }

// What a chat tier cannot run. A category the server stamped wins over the
// bundled table, as on the admin dashboard's tier cards.
const NOT_CHAT = new Set(['Embedding', 'OCR', 'Moderation', 'Audio']);

const isChatModel = (m: { id: string; cat?: string }): boolean => {
    const cat = m.cat || (getModelMeta(m.id) as { cat?: string } | null)?.cat || '';
    return !NOT_CHAT.has(cat);
};

async function json<T>(fetcher: Fetcher, url: string): Promise<T | null> {
    try {
        const res = await fetcher(url);
        return res.ok ? (await res.json()) as T : null;
    } catch {
        return null;
    }
}

/**
 * Every chat model of every connected provider, each carrying its provider's
 * name (`provider`, which the picker groups by). A provider whose model list
 * fails contributes nothing; the others still load.
 */
export default async function loadChatModels(fetcher: Fetcher, apiBase: string): Promise<ProviderModel[]> {
    const data = await json<{ providers?: Provider[] }>(fetcher, `${apiBase}/ai/providers`);
    const providers = data?.providers || [];
    const lists = await Promise.all(providers.map(async (p) => {
        const res = await json<{ models?: Array<{ id: string; cat?: string }> }>(
            fetcher, `${apiBase}/ai/providers/${encodeURIComponent(p.id)}/models`);
        return (res?.models || [])
            .filter(m => m && typeof m.id === 'string' && isChatModel(m))
            .map(m => ({
                ...m,
                provider: p.name,
                providerId: p.id,
                providerName: p.name,
                providerType: p.type,
            }));
    }));
    return lists.flat();
}
