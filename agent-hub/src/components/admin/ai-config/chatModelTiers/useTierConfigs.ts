import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { CustomTier, StatusMessage, TierConfig } from './tierTypes';
import { flash } from './tierTypes';
import { getAiConfig, postAiConfig } from '@/api/aiConfig';
import { useTranslation } from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';

const initialTiers = (): TierConfig => ({
    fast: { modelId: '', label: 'Fast' },
    standard: { modelId: '', label: 'Flow (Direct)' },
    swarm: { modelId: '', label: 'Swarm (Direct)' },
    thinking: { modelId: '', label: 'Thinking' },
    writer: { modelId: '', label: 'Writer' },
    pro: { modelId: '', label: 'Deep Thinking' }
});

export interface TierConfigsState {
    config: TierConfig;
    setConfig: Dispatch<SetStateAction<TierConfig>>;
    euConfig: TierConfig;
    saving: boolean;
    euSaving: boolean;
    message: StatusMessage | null;
    euMessage: StatusMessage | null;
    expandedTier: string | null;
    setExpandedTier: Dispatch<SetStateAction<string | null>>;
    loadConfig: () => Promise<void>;
    loadEuConfig: () => Promise<void>;
    save: () => Promise<void>;
    saveEu: () => Promise<void>;
    updateTier: (tierKey: string, field: string, value: unknown) => void;
    updateEuTier: (tierKey: string, field: string, value: unknown) => void;
}

/** ' (warning; warning)' from the custom-tier save, and the tiers as the server kept them. */
async function readCustomSave(customRes: Response, setCustomTiers: (tiers: CustomTier[]) => void): Promise<string> {
    let warn = '';
    try {
        const j = customRes.ok ? await customRes.json() : null;
        if (j && Array.isArray(j.warnings) && j.warnings.length > 0) warn = ' (' + j.warnings.join('; ') + ')';
        if (j && Array.isArray(j.tiers)) setCustomTiers(j.tiers);
    } catch (err) { logger.debug('ignore', err); }
    return warn;
}

/**
 * The standard tiers (global and EU-only) and their saves. Each save also
 * writes the whole custom-tier array, so one click persists everything the
 * admin edited in that section.
 */
export default function useTierConfigs(customTiers: CustomTier[], setCustomTiers: (tiers: CustomTier[]) => void): TierConfigsState {
    const { t } = useTranslation();
    const [config, setConfig] = useState<TierConfig>(initialTiers);
    const [euConfig, setEuConfig] = useState<TierConfig>(initialTiers);
    const [saving, setSaving] = useState(false);
    const [euSaving, setEuSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);
    const [euMessage, setEuMessage] = useState<StatusMessage | null>(null);
    const [expandedTier, setExpandedTier] = useState<string | null>(null);

    const loadConfig = async () => {
        try {
            const res = await getAiConfig('chat-models');
            if (res.ok) setConfig(await res.json());
        } catch (e) { console.error('Failed to load chat model tiers:', e); }
    };

    const loadEuConfig = async () => {
        try {
            const res = await getAiConfig('chat-models-eu');
            if (res.ok) setEuConfig(await res.json());
        } catch (e) { console.error('Failed to load EU chat model tiers:', e); }
    };

    const save = async () => {
        setSaving(true);
        try {
            const [res, customRes] = await Promise.all([
                postAiConfig('chat-models', config),
                postAiConfig('custom-chat-models', { tiers: customTiers }),
            ]);
            const bothOk = res.ok && customRes.ok;
            const warn = await readCustomSave(customRes, setCustomTiers);
            if (bothOk) {
                flash(setMessage, { type: warn ? 'warning' : 'success', text: t('admin_ai_config.tiers_saved', 'Chat model tiers saved{warn}', { warn }) }, 4000);
            } else {
                setMessage({ type: 'error', text: t('admin_ai_config.tiers_save_failed_some', 'Failed to save (one or more configs)') });
            }
        } catch (e) {
            setMessage({ type: 'error', text: t('admin_ai_config.tiers_save_failed', 'Failed to save tier config') });
        }
        setSaving(false);
    };

    const saveEu = async () => {
        setEuSaving(true);
        try {
            // Save EU standard tiers AND the full custom tiers array (which now
            // contains each custom tier's euModelId). The custom-chat-models
            // endpoint overwrites wholesale so race with `save()` is avoided as
            // long as both callers write from the same local state.
            const [res, customRes] = await Promise.all([
                postAiConfig('chat-models-eu', euConfig),
                postAiConfig('custom-chat-models', { tiers: customTiers }),
            ]);
            if (res.ok && customRes.ok) {
                flash(setEuMessage, { type: 'success', text: t('admin_ai_config.tiers_eu_saved', 'EU model tiers saved!') }, 3000);
            } else {
                setEuMessage({ type: 'error', text: t('admin_ai_config.tiers_eu_save_failed_short', 'Failed to save') });
            }
        } catch (e) {
            setEuMessage({ type: 'error', text: t('admin_ai_config.tiers_eu_save_failed', 'Failed to save EU tier config') });
        }
        setEuSaving(false);
    };

    const updateTier = (tierKey: string, field: string, value: unknown) => {
        setConfig(prev => ({
            ...prev,
            [tierKey]: { ...prev[tierKey], [field]: value }
        }));
    };

    const updateEuTier = (tierKey: string, field: string, value: unknown) => {
        setEuConfig(prev => ({
            ...prev,
            [tierKey]: { ...prev[tierKey], [field]: value }
        }));
    };

    return {
        config, setConfig, euConfig, saving, euSaving, message, euMessage, expandedTier, setExpandedTier,
        loadConfig, loadEuConfig, save, saveEu, updateTier, updateEuTier,
    };
}
