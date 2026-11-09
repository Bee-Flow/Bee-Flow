// "AI Step Model" section of ChatModelTiersConfig — a TEMPORARY override.
// Mirrors MemoryExtractionModelSection: same layout, same prop contract, one
// config key (`ai_step_model`) behind /api/ai/config/ai-step-model.
//
// Why it exists: an automation's ai_step inherits the Auto/Fast tier the builder
// writes for it. On a single-slot self-hosted server that is the model the
// builder itself runs on, so a dry run with a few AI steps evicts the
// builder's prompt cache and queues full prompt evaluations before the next
// round. Pointing the default tier at a tiny model keeps a demo build warm.
// Explicit heavier tiers are untouched (core/automationRunner/aiStepModel.js).
import React from 'react';
import ModelSettingRow from './ModelSettingRow';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { useTranslation } from '@/hooks/useTranslation';

interface AiStepModelSectionProps extends ModelPickerSource {
    aiStepModel: ModelSetting['model'];
    setAiStepModel: ModelSetting['setModel'];
    aiStepModelSaving: ModelSetting['saving'];
    aiStepModelMessage: ModelSetting['message'];
    saveAiStepModel: ModelSetting['save'];
}

export default function AiStepModelSection({
    aiStepModel, setAiStepModel, aiStepModelSaving, aiStepModelMessage,
    saveAiStepModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}: AiStepModelSectionProps) {
    const { t } = useTranslation();
    return (
        <ModelSettingRow
            title={t('admin_ai_config.tier_aistep_title', 'AI Step Model (temporary override)')}
            hint={t('admin_ai_config.tier_aistep_hint', 'Model every automation AI step runs on when the step asks for Auto or Fast, the tiers the builder writes by default. Temporary switch: on a self-hosted single-slot server it keeps a dry run from evicting the builder\'s prompt cache on the big model. Steps that explicitly pick Thinking or another tier keep their own model. Unset: the step\'s own tier, as before.')}
            emptyLabel={t('admin_ai_config.tier_aistep_default', '— Use the step\'s own tier —')}
            saveLabel={t('admin_ai_config.tier_aistep_save', 'Save AI Step Model')}
            model={aiStepModel}
            setModel={setAiStepModel}
            saving={aiStepModelSaving}
            message={aiStepModelMessage}
            save={saveAiStepModel}
            chatModels={chatModels}
            byProvider={byProvider}
            hiddenModelIds={hiddenModelIds}
            toggleHiddenModel={toggleHiddenModel}
        />
    );
}
