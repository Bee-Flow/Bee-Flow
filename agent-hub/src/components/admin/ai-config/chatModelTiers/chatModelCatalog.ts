import { useState } from 'react';
import { getModelMeta, isReasoningCapable } from './modelMeta';
import type { CatalogModel } from './tierTypes';
import { API_BASE, authFetch } from '../../../../utils/helpers';

const NON_CHAT_CATEGORIES = ['Embedding', 'OCR', 'Moderation', 'Audio'];

export interface ChatModelCatalog {
    chatModels: CatalogModel[];
    isLocal: (id: string) => boolean;
    reasoningCapable: (id: string) => boolean;
    /** Provider name → its chat models (reused by every picker). */
    byProvider: Record<string, CatalogModel[]>;
}

/** The chat-capable models, and what each picker needs to know about them. */
export function buildChatModelCatalog(allModels: CatalogModel[]): ChatModelCatalog {
    // Filter to only chat-compatible models. A category the server stamped
    // wins over the bundled table: the server read it from the provider's own
    // model list (Mistral's /v1/models says which models cannot chat), while
    // the table matches by prefix — `codestral-embed` looked like Codestral.
    const chatModels = allModels.filter(m => {
        const cat = m.cat || getModelMeta(m.id)?.cat || '';
        return !NON_CHAT_CATEGORIES.includes(cat);
    });

    // Self-hosted reasoning models (Qwen3, DeepSeek-R1, gpt-oss, …) take the
    // same none/low/medium/high effort scale: the local adapter maps it onto
    // Ollama's `think` levels and vLLM's `enable_thinking`. The bundled regex
    // tables only know cloud model ids, so the flags the server stamped on the
    // model are what tells us here.
    const localModelIds = new Set(chatModels.filter(m => m.local).map(m => m.id));
    const localReasoningIds = new Set(chatModels.filter(m => m.local && m.reasoning).map(m => m.id));
    // A model that carries its own effort vocabulary (Mistral Small 4 and
    // Medium 3.5: none/high) is reasoning-capable on the server's word too.
    const stampedReasoningIds = new Set(chatModels.filter(m => m.reasoning && Array.isArray(m.efforts)).map(m => m.id));
    const isLocal = (id: string) => localModelIds.has(id);
    const reasoningCapable = (id: string) => isReasoningCapable(id) || localReasoningIds.has(id) || stampedReasoningIds.has(id);

    // Build grouped model list (reused by both sections)
    const byProvider: Record<string, CatalogModel[]> = {};
    chatModels.forEach(m => {
        const key = m.providerName || 'Unknown';
        if (!byProvider[key]) byProvider[key] = [];
        byProvider[key].push(m);
    });

    return { chatModels, isLocal, reasoningCapable, byProvider };
}

export interface HiddenModelsState {
    hiddenModelIds: string[];
    loadHiddenModels: () => Promise<void>;
    toggleHiddenModel: (modelId: string) => Promise<void>;
}

/** Models the admin hid from every picker. */
export function useHiddenModels(): HiddenModelsState {
    const [hiddenModelIds, setHiddenModelIds] = useState<string[]>([]);

    const loadHiddenModels = async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/hidden-models`);
            if (res.ok) {
                const data = await res.json();
                setHiddenModelIds(Array.isArray(data.modelIds) ? data.modelIds : []);
            }
        } catch (e) { console.error('Failed to load hidden models:', e); }
    };

    // Optimistically toggle and persist. Roll back on failure so the picker
    // and the server never disagree.
    const toggleHiddenModel = async (modelId: string) => {
        const prev = hiddenModelIds;
        const next = prev.includes(modelId)
            ? prev.filter(id => id !== modelId)
            : [...prev, modelId];
        setHiddenModelIds(next);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/hidden-models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelIds: next }),
            });
            if (!res.ok) throw new Error('save failed');
            const data = await res.json();
            if (Array.isArray(data.modelIds)) setHiddenModelIds(data.modelIds);
        } catch (e) {
            console.error('Failed to save hidden models:', e);
            setHiddenModelIds(prev);
        }
    };

    return { hiddenModelIds, loadHiddenModels, toggleHiddenModel };
}
