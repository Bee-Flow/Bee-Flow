import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getAiConfig, postAiConfig } from '@/api/aiConfig';

/**
 * One single-model setting (classifier, title, memory extraction, AI step,
 * data extraction): GET/POST `/ai/config/<path>` with `{ modelId }`, '' for
 * "use the default". Part of the Models page's one draft: `model` is the
 * draft, `saved` what the server holds; the page's save bar calls `persist`.
 */
export interface ModelSetting {
    model: string;
    setModel: Dispatch<SetStateAction<string>>;
    saved: string;
    dirty: boolean;
    load: () => Promise<void>;
    /** Store the draft: null when the server took it, else what went wrong ('' when it gave no reason). */
    persist: () => Promise<string | null>;
    /** Put the draft back to what is stored. */
    discard: () => void;
}

const modelIdOf = (data: { modelId?: unknown }) => (typeof data.modelId === 'string' ? data.modelId : '');

export default function useModelSetting(path: string, noun: string): ModelSetting {
    const [model, setModel] = useState('');
    const [saved, setSaved] = useState('');

    const load = async () => {
        try {
            const res = await getAiConfig(path);
            if (res.ok) {
                const id = modelIdOf(await res.json());
                setModel(id);
                setSaved(id);
            }
        } catch (e) { console.error(`Failed to load ${noun}:`, e); }
    };

    const persist = async () => {
        try {
            const res = await postAiConfig(path, { modelId: model || null });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return typeof data.error === 'string' ? data.error : '';
            const id = 'modelId' in data ? modelIdOf(data) : model;
            setModel(id);
            setSaved(id);
            return null;
        } catch (e) {
            console.error(`Failed to save ${noun}:`, e);
            return '';
        }
    };

    return { model, setModel, saved, dirty: model !== saved, load, persist, discard: () => setModel(saved) };
}
