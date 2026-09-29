// Shared state + CRUD for the admin `/ai/config` endpoint — replaces the
// fetch-status / save / delete boilerplate that was copy-pasted across the
// provider cards (ClaudeCard, OpenAICard, GoogleCard, MistralCard,
// ElevenLabsCard, AzureCard, GoogleVertexCard) and RerankerConfig:
//
//   useEffect(() => { fetchStatus(); }, []);
//   const fetchStatus = async () => { ... GET /ai/config ... };
//   const handleSave = async () => { ... POST /ai/config ... };
//   const handleDelete = async () => { ... DELETE /ai/config/key/<slug> ... };
//
// Usage:
//   const { config, saving, save, deleteKey, deleteSetting, patchConfig } =
//       useProviderConfig({ onMessage, onLoaded: data => { /* hydrate form */ } });
//   const hasKey = !!config?.hasClaudeKey;
//   const ok = await save({ claudeApiKey: apiKey },
//       { success: 'Claude API key saved!', error: 'Failed to save API key' });
//
// `save`, `deleteKey` and `deleteSetting` resolve to `true` on success and
// surface the given success/error text through `onMessage`. `config` is the
// raw GET /ai/config JSON (null until loaded); after a mutation, call
// `patchConfig({ hasClaudeKey: true })` to update the derived has-flags
// optimistically instead of refetching.

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';

/** The raw GET /ai/config body: per-provider has-flags and plain settings.
 *  Each card reads its own keys, so the shape stays open. */
export type ProviderConfig = Record<string, unknown>;

export interface ProviderMessage {
    type: 'success' | 'error';
    text: string;
}

/** What to say through `onMessage` for either outcome; omit to stay silent. */
export interface MutationMessages {
    success?: string;
    error?: string;
}

export interface UseProviderConfigOptions {
    onMessage?: (message: ProviderMessage) => void;
    onLoaded?: (config: ProviderConfig) => void;
}

export interface UseProviderConfigReturn {
    config: ProviderConfig | null;
    saving: boolean;
    refresh: () => Promise<ProviderConfig | null>;
    patchConfig: (partial: ProviderConfig) => void;
    save: (body: unknown, messages?: MutationMessages) => Promise<boolean>;
    deleteKey: (slug: string, messages?: MutationMessages) => Promise<boolean>;
    deleteSetting: (slug: string, messages?: MutationMessages) => Promise<boolean>;
}

export default function useProviderConfig(
    { onMessage, onLoaded }: UseProviderConfigOptions = {},
): UseProviderConfigReturn {
    const [config, setConfig] = useState<ProviderConfig | null>(null);
    const [saving, setSaving] = useState(false);
    // Keep the latest callbacks in refs so callers can pass inline functions
    // without retriggering the initial fetch.
    const onMessageRef = useRef(onMessage);
    const onLoadedRef = useRef(onLoaded);
    onMessageRef.current = onMessage;
    onLoadedRef.current = onLoaded;

    const notify = useCallback((type: ProviderMessage['type'], text?: string) => {
        if (text) onMessageRef.current?.({ type, text });
    }, []);

    const refresh = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config`);
            if (res.ok) {
                const data: ProviderConfig = await res.json();
                setConfig(data);
                onLoadedRef.current?.(data);
                return data;
            }
        } catch (e) {
            console.error('Failed to fetch AI config:', e);
        }
        return null;
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // Merge a partial update into the cached config (e.g. flip a has-flag
    // after a successful save/delete without a refetch).
    const patchConfig = useCallback((partial: ProviderConfig) => {
        setConfig(prev => ({ ...(prev || {}), ...partial }));
    }, []);

    const save = useCallback(async (body: unknown, { success, error }: MutationMessages = {}) => {
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (res.ok) {
                notify('success', success);
                return true;
            }
            notify('error', error);
            return false;
        } catch {
            notify('error', error);
            return false;
        } finally {
            setSaving(false);
        }
    }, [notify]);

    // kind: 'key' (encrypted secrets) or 'setting' (plain config values)
    const removeEntry = useCallback(async (
        kind: 'key' | 'setting',
        slug: string,
        { success, error }: MutationMessages = {},
    ) => {
        try {
            const res = await authFetch(`${API_BASE}/ai/config/${kind}/${slug}`, { method: 'DELETE' });
            if (res.ok) {
                notify('success', success);
                return true;
            }
            notify('error', error);
            return false;
        } catch {
            notify('error', error);
            return false;
        }
    }, [notify]);

    const deleteKey = useCallback(
        (slug: string, messages?: MutationMessages) => removeEntry('key', slug, messages),
        [removeEntry],
    );
    const deleteSetting = useCallback(
        (slug: string, messages?: MutationMessages) => removeEntry('setting', slug, messages),
        [removeEntry],
    );

    return { config, saving, refresh, patchConfig, save, deleteKey, deleteSetting };
}
