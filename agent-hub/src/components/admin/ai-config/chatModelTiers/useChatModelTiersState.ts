// State core of ChatModelTiersConfig: composes one hook per concern (standard
// tiers, custom tiers, Claude settings, hidden models and the five
// single-model settings) and runs their loads once on mount. Called first
// (and only) in the panel so all state stays owned by the panel's fiber; the
// section components receive these bindings by explicit threading.
import { useEffect, useEffectEvent } from 'react';
import { buildChatModelCatalog, useHiddenModels } from './chatModelCatalog';
import type { CatalogModel } from './tierTypes';
import useClaudeSettings from './useClaudeSettings';
import useCustomTiers from './useCustomTiers';
import useModelSetting from './useModelSetting';
import useTierConfigs from './useTierConfigs';
import useConfirm from '../../../shared/useConfirm';

export default function useChatModelTiersState(allModels: CatalogModel[]) {
    const { confirm, confirmDialog } = useConfirm();
    const custom = useCustomTiers(confirm);
    const tiers = useTierConfigs(custom.customTiers, custom.setCustomTiers);
    const classifier = useModelSetting('auto-classifier', { noun: 'classifier model', saved: 'Classifier model saved' });
    const title = useModelSetting('title-model', { noun: 'title model', saved: 'Title model saved' });
    const memory = useModelSetting('memory-extraction-model', { noun: 'memory extraction model', saved: 'Memory extraction model saved' });
    // TEMPORARY ai_step override — same contract as the memory model, one key.
    const aiStep = useModelSetting('ai-step-model', { noun: 'AI step model', saved: 'AI step model saved' });
    // The automation Extract data step's own model — same contract, key
    // `data_extraction_model`. Separate from the ai_step override on purpose.
    const dataExtraction = useModelSetting('data-extraction-model', { noun: 'data extraction model', saved: 'Data extraction model saved' });
    const hidden = useHiddenModels();
    const claude = useClaudeSettings(tiers.config, tiers.setConfig);

    const runAiStepEffect = useEffectEvent(() => {
        tiers.loadConfig();
        tiers.loadEuConfig();
        custom.loadCustomTiers();
        classifier.load();
        title.load();
        memory.load();
        aiStep.load();
        dataExtraction.load();
        hidden.loadHiddenModels();
        claude.loadClaudeSettings();
    });
    useEffect(() => { return runAiStepEffect(); }, []);

    const { chatModels, isLocal, reasoningCapable, byProvider } = buildChatModelCatalog(allModels);

    return {
        config: tiers.config, euConfig: tiers.euConfig, customTiers: custom.customTiers,
        saving: tiers.saving, euSaving: tiers.euSaving, message: tiers.message, euMessage: tiers.euMessage,
        expandedTier: tiers.expandedTier, setExpandedTier: tiers.setExpandedTier,
        expandedCustomId: custom.expandedCustomId, setExpandedCustomId: custom.setExpandedCustomId,
        classifierModel: classifier.model, setClassifierModel: classifier.setModel, classifierSaving: classifier.saving,
        classifierMessage: classifier.message, saveClassifierModel: classifier.save,
        titleModel: title.model, setTitleModel: title.setModel, titleModelSaving: title.saving,
        titleModelMessage: title.message, saveTitleModel: title.save,
        memoryModel: memory.model, setMemoryModel: memory.setModel, memoryModelSaving: memory.saving,
        memoryModelMessage: memory.message, saveMemoryModel: memory.save,
        aiStepModel: aiStep.model, setAiStepModel: aiStep.setModel, aiStepModelSaving: aiStep.saving,
        aiStepModelMessage: aiStep.message, saveAiStepModel: aiStep.save,
        dataExtractionModel: dataExtraction.model, setDataExtractionModel: dataExtraction.setModel,
        dataExtractionModelSaving: dataExtraction.saving, dataExtractionModelMessage: dataExtraction.message,
        saveDataExtractionModel: dataExtraction.save,
        hiddenModelIds: hidden.hiddenModelIds, toggleHiddenModel: hidden.toggleHiddenModel,
        claudeAutoRetry: claude.claudeAutoRetry, setClaudeAutoRetry: claude.setClaudeAutoRetry,
        claudeSaving: claude.claudeSaving, claudeMessage: claude.claudeMessage, claudeRecAppliedTier: claude.claudeRecAppliedTier,
        saveClaudeSettings: claude.saveClaudeSettings, applyClaudeRecommendedForTier: claude.applyClaudeRecommendedForTier,
        applyAllClaudeRecommended: claude.applyAllClaudeRecommended,
        save: tiers.save, saveEu: tiers.saveEu, updateTier: tiers.updateTier, updateEuTier: tiers.updateEuTier,
        addCustomTier: custom.addCustomTier, updateCustomTier: custom.updateCustomTier, renameCustomTier: custom.renameCustomTier,
        removeCustomTier: custom.removeCustomTier, toggleCustomTaskType: custom.toggleCustomTaskType,
        chatModels, isLocal, reasoningCapable, byProvider, confirmDialog,
    };
}
