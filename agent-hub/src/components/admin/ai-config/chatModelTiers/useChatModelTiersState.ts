// State core of ChatModelTiersConfig (the Models page): composes one hook per
// concern (standard and EU tiers, custom tiers, the Claude recommendations,
// the reliability switch, hidden models and the five background models) and
// runs their loads once on mount. Everything except the two switches (hidden
// models, the reliability retry), which save on their own, is ONE draft: the
// page's save bar stores what changed, Discard puts it all back. Called first
// (and only) in the panel so all state stays owned by the panel's fiber; the
// section components receive these bindings by explicit threading.
import { useEffect, useEffectEvent, useState } from 'react';
import { buildChatModelCatalog, useHiddenModels } from './chatModelCatalog';
import type { CatalogModel } from './tierTypes';
import useClaudeSettings from './useClaudeSettings';
import useCustomTiers from './useCustomTiers';
import useModelSetting from './useModelSetting';
import useReliabilitySettings from './useReliabilitySettings';
import useTierConfigs from './useTierConfigs';
import { useTranslation } from '@/hooks/useTranslation';
import useConfirm from '@/components/shared/useConfirm';

interface ModelsSaveMessage {
    type: 'success' | 'error';
    text: string;
}

/** One stored part of the draft: whether it changed, and how to store it (null: stored; else the reason, '' for none). */
interface DraftPart {
    dirty: boolean;
    persist: () => Promise<string | null>;
}

/** Store every changed part at once; the error texts of the parts that failed (a stored part leaves the draft). */
async function persistChanged(parts: readonly DraftPart[]): Promise<string[]> {
    const outcomes = await Promise.all(parts.filter(p => p.dirty).map(p => p.persist()));
    return outcomes.filter((o): o is string => o !== null);
}

type CustomSave = Pick<ReturnType<typeof useCustomTiers>, 'customDirty' | 'persistCustomTiers'>;

/** The page's one Save: store every changed part, then say how it went (the save bar's message). */
function useModelsSave(parts: readonly DraftPart[], custom: CustomSave) {
    const { t } = useTranslation();
    const [saving, setSaving] = useState(false);
    const [saveMessage, setSaveMessage] = useState<ModelsSaveMessage | null>(null);

    const say = (message: ModelsSaveMessage) => {
        setSaveMessage(message);
        setTimeout(() => setSaveMessage(curr => (curr === message ? null : curr)), 4000);
    };

    const saveAll = async () => {
        setSaving(true);
        try {
            const customRun = custom.customDirty ? custom.persistCustomTiers() : Promise.resolve({ error: null, warning: '' });
            const [errors, customOutcome] = await Promise.all([persistChanged(parts), customRun]);
            if (customOutcome.error !== null) errors.push(customOutcome.error);
            if (errors.length > 0) {
                const reasons = errors.filter(Boolean).join('; ');
                say({ type: 'error', text: reasons
                    ? t('ai_model_setup.models_save_failed_reason', 'Not everything was saved: {reason}', { reason: reasons })
                    : t('ai_model_setup.models_save_failed', 'Not everything was saved. The changes that failed are still here: try again.') });
            } else {
                say({ type: 'success', text: customOutcome.warning
                    ? t('ai_model_setup.models_saved_warning', 'Saved{warning}', { warning: customOutcome.warning })
                    : t('ai_model_setup.models_saved', 'Saved') });
            }
        } finally {
            setSaving(false);
        }
    };

    return { saving, saveMessage, setSaveMessage, saveAll };
}

export default function useChatModelTiersState(allModels: CatalogModel[]) {
    const { confirm, confirmDialog } = useConfirm();
    const custom = useCustomTiers(confirm);
    const tiers = useTierConfigs();
    const classifier = useModelSetting('auto-classifier', 'classifier model');
    const title = useModelSetting('title-model', 'title model');
    const memory = useModelSetting('memory-extraction-model', 'memory extraction model');
    // The model automation AI steps run on when they ask for Auto or Fast.
    const aiStep = useModelSetting('ai-step-model', 'AI step model');
    // The automation Extract data step's own model, separate from the AI step one on purpose.
    const dataExtraction = useModelSetting('data-extraction-model', 'data extraction model');
    const hidden = useHiddenModels();
    const claude = useClaudeSettings({ setConfig: tiers.setConfig, setEuConfig: tiers.setEuConfig });
    const reliability = useReliabilitySettings();
    const runLoadEffect = useEffectEvent(() => {
        tiers.loadConfig();
        tiers.loadEuConfig();
        custom.loadCustomTiers();
        classifier.load();
        title.load();
        memory.load();
        aiStep.load();
        dataExtraction.load();
        hidden.loadHiddenModels();
        reliability.load();
    });
    useEffect(() => { return runLoadEffect(); }, []);

    const backgroundModels = [classifier, title, memory, aiStep, dataExtraction];
    const dirty = tiers.tiersDirty || tiers.euDirty || custom.customDirty || backgroundModels.some(m => m.dirty);

    const { saving, saveMessage, setSaveMessage, saveAll } = useModelsSave([
        { dirty: tiers.tiersDirty, persist: tiers.persistTiers },
        { dirty: tiers.euDirty, persist: tiers.persistEu },
        ...backgroundModels.map(m => ({ dirty: m.dirty, persist: m.persist })),
    ], custom);

    const discardAll = () => {
        tiers.discardTiers();
        custom.discardCustomTiers();
        backgroundModels.forEach(m => m.discard());
        setSaveMessage(null);
    };

    const { chatModels, isLocal, reasoningCapable, byProvider } = buildChatModelCatalog(allModels);

    return {
        config: tiers.config, euConfig: tiers.euConfig, customTiers: custom.customTiers,
        expandedTier: tiers.expandedTier, setExpandedTier: tiers.setExpandedTier,
        expandedEuTier: tiers.expandedEuTier, setExpandedEuTier: tiers.setExpandedEuTier,
        expandedCustomId: custom.expandedCustomId, setExpandedCustomId: custom.setExpandedCustomId,
        classifier, title, memory, aiStep, dataExtraction,
        hiddenModelIds: hidden.hiddenModelIds, toggleHiddenModel: hidden.toggleHiddenModel,
        reliability,
        claudeMessage: claude.claudeMessage, claudeRecAppliedTier: claude.claudeRecAppliedTier,
        applyClaudeRecommendedForTier: claude.applyClaudeRecommendedForTier,
        applyAllClaudeRecommended: claude.applyAllClaudeRecommended,
        updateTier: tiers.updateTier, updateEuTier: tiers.updateEuTier,
        addCustomTier: custom.addCustomTier, updateCustomTier: custom.updateCustomTier, renameCustomTier: custom.renameCustomTier,
        removeCustomTier: custom.removeCustomTier, toggleCustomTaskType: custom.toggleCustomTaskType,
        dirty, saving, saveMessage, saveAll, discardAll,
        chatModels, isLocal, reasoningCapable, byProvider, confirmDialog,
    };
}
