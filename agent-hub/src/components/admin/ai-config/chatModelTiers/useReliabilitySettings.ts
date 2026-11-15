// The Reliability switch of the Models page: retry once without thinking when
// a turn ends with thinking but no answer. A switch, so it saves on its own
// (SaveStatus), outside the page's draft. Stored under the key the server reads
// (`claude_settings.autoRetryOnEmpty`, GET/POST /ai/config/claude-settings, a
// route the mobile app reads too).
import { useState } from 'react';
import { getAiConfig, postAiConfig } from '@/api/aiConfig';

type ReliabilitySaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface ReliabilitySettingsState {
    autoRetry: boolean;
    saveState: ReliabilitySaveState;
    lastSavedAt: Date | null;
    load: () => Promise<void>;
    /** Switch the retry on or off and store it; on a refusal the switch goes back. */
    setAutoRetry: (next: boolean) => Promise<void>;
}

export default function useReliabilitySettings(): ReliabilitySettingsState {
    const [autoRetry, setAutoRetryState] = useState(true);
    const [saveState, setSaveState] = useState<ReliabilitySaveState>('idle');
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

    const load = async () => {
        try {
            const res = await getAiConfig('claude-settings');
            if (res.ok) {
                const data = await res.json();
                setAutoRetryState(data.autoRetryOnEmpty !== false);
            }
        } catch (e) { console.error('Failed to load the reliability settings:', e); }
    };

    const setAutoRetry = async (next: boolean) => {
        const before = autoRetry;
        setAutoRetryState(next);
        setSaveState('saving');
        try {
            const res = await postAiConfig('claude-settings', { autoRetryOnEmpty: next });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setSaveState('saved');
            setLastSavedAt(new Date());
        } catch (e) {
            console.error('Failed to save the reliability settings:', e);
            setAutoRetryState(before);
            setSaveState('error');
        }
    };

    return { autoRetry, saveState, lastSavedAt, load, setAutoRetry };
}
