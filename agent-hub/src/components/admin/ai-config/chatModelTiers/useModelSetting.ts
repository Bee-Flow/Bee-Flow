import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { StatusMessage } from './tierTypes';
import { getAiConfig, postAiConfig } from '@/api/aiConfig';

/**
 * One single-model setting (classifier, title, memory extraction, AI step,
 * data extraction): GET/POST `/ai/config/<path>` with `{ modelId }`, '' for
 * "use the default".
 */
export interface ModelSetting {
    model: string;
    setModel: Dispatch<SetStateAction<string>>;
    saving: boolean;
    message: StatusMessage | null;
    load: () => Promise<void>;
    save: (next?: string) => Promise<void>;
}

interface ModelSettingLabels {
    /** e.g. 'classifier model' — used in the console and the error text. */
    noun: string;
    /** e.g. 'Classifier model saved' */
    saved: string;
}

const modelIdOf = (data: { modelId?: unknown }) => (typeof data.modelId === 'string' ? data.modelId : '');

export default function useModelSetting(path: string, { noun, saved }: ModelSettingLabels): ModelSetting {
    const [model, setModel] = useState('');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);

    const load = async () => {
        try {
            const res = await getAiConfig(path);
            if (res.ok) {
                setModel(modelIdOf(await res.json()));
            }
        } catch (e) { console.error(`Failed to load ${noun}:`, e); }
    };

    const save = async (next = model) => {
        setSaving(true);
        try {
            const res = await postAiConfig(path, { modelId: next || null });
            if (res.ok) {
                setModel(modelIdOf(await res.json()));
                setMessage({ type: 'success', text: saved });
                setTimeout(() => setMessage(null), 3000);
            } else {
                const data = await res.json().catch(() => ({}));
                setMessage({ type: 'error', text: data.error || `Failed to save ${noun}` });
            }
        } catch (e) {
            setMessage({ type: 'error', text: `Failed to save ${noun}` });
        }
        setSaving(false);
    };

    return { model, setModel, saving, message, load, save };
}
