// "Memory Extraction Model" section of ChatModelTiersConfig. Mirrors
// TitleModelSection: same layout, same prop contract, one config key
// (`memory_extraction_model`) behind /api/ai/config/memory-extraction-model.
//
// Why it exists: after every reply two background extractors read the
// exchange for facts worth remembering. They inherit the Fast tier, which on
// a self-hosted single-slot server is the model the chat itself just used —
// each extraction then queues a full prompt evaluation in front of the next
// turn. A tiny dedicated model keeps the slot free.
import React from 'react';
import ModelSettingRow from './ModelSettingRow';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { useTranslation } from '@/hooks/useTranslation';

interface MemoryExtractionModelSectionProps extends ModelPickerSource {
    memoryModel: ModelSetting['model'];
    setMemoryModel: ModelSetting['setModel'];
    memoryModelSaving: ModelSetting['saving'];
    memoryModelMessage: ModelSetting['message'];
    saveMemoryModel: ModelSetting['save'];
}

export default function MemoryExtractionModelSection({
    memoryModel, setMemoryModel, memoryModelSaving, memoryModelMessage,
    saveMemoryModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}: MemoryExtractionModelSectionProps) {
    const { t } = useTranslation();
    return (
        <ModelSettingRow
            title={t('admin_ai_config.tier_mem_title', 'Memory Extraction Model')}
            hint={t('admin_ai_config.tier_mem_hint', 'Model that reads each finished exchange for facts worth remembering: a small background call after every reply, thinking off. On a self-hosted single-slot server pick a tiny model here so extraction never queues in front of the next turn. Defaults to the Fast tier model when unset.')}
            emptyLabel={t('admin_ai_config.tier_use_fast', '— Use Fast tier model —')}
            saveLabel={t('admin_ai_config.tier_mem_save', 'Save Memory Extraction Model')}
            model={memoryModel}
            setModel={setMemoryModel}
            saving={memoryModelSaving}
            message={memoryModelMessage}
            save={saveMemoryModel}
            chatModels={chatModels}
            byProvider={byProvider}
            hiddenModelIds={hiddenModelIds}
            toggleHiddenModel={toggleHiddenModel}
        />
    );
}
