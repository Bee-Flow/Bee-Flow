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
import { useQueryClient } from '@tanstack/react-query';
import { aiConfigKey, useAiConfigQuery, type AiConfigRead } from '../api/queries/aiConfigRead';
import { API_BASE } from '../utils/helpers';
import { mutate, ApiError } from '../api/mutate';

/** The raw GET /ai/config body: per-provider has-flags and plain settings.
 *  Each card reads its own keys, so the shape stays open. */
interface ProviderConfig {
    /** Always a string: the server falls back to 'europe-west4' (routes/ai/config/instanceConfig.js). */
    googleVertexLocation?: string;
    /** Always a string: the server answers `|| ''` (routes/ai/config/instanceConfig.js). */
    azureModels?: string;
    /** Always a string: the server falls back to the Cohere default (routes/ai/config/instanceConfig.js). */
    azureRerankerModel?: string;
    [key: string]: unknown;
}

export interface ProviderMessage {
    type: 'success' | 'error';
    text: string;
}

/** What to say through `onMessage` for either outcome; omit to stay silent. */
interface MutationMessages {
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
    const queryClient = useQueryClient();
    const query = useAiConfigQuery<ProviderConfig>();
    const config = query.data?.config ?? null;
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

    // The form is hydrated from every real read (a refresh, the first load),
    // never from a local patch: those keep the read number they came from.
    const answer = query.data;
    const hydratedRead = useRef<number | null>(null);
    useEffect(() => {
        if (!answer || answer.read < 0 || answer.read === hydratedRead.current) return;
        hydratedRead.current = answer.read;
        if (answer.config) onLoadedRef.current?.(answer.config);
    }, [answer]);

    const { refetch } = query;
    const refresh = useCallback(async () => {
        const result = await refetch();
        return result.isError ? null : result.data?.config ?? null;
    }, [refetch]);

    // Merge a partial update into the cached config (e.g. flip a has-flag
    // after a successful save/delete without a refetch).
    const patchConfig = useCallback((partial: ProviderConfig) => {
        queryClient.setQueryData<AiConfigRead<ProviderConfig>>(aiConfigKey, (prev) => ({
            read: prev?.read ?? -1,
            config: { ...(prev?.config || {}), ...partial },
        }));
    }, [queryClient]);

    const save = useCallback(async (body: unknown, { success, error }: MutationMessages = {}) => {
        setSaving(true);
        try {
            const res = await mutate(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
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
            const res = await mutate(`${API_BASE}/ai/config/${kind}/${slug}`, { method: 'DELETE' }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
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
