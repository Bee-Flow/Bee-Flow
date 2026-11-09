// "Data Extraction Model" section of ChatModelTiersConfig. Mirrors
// MemoryExtractionModelSection: same layout, same prop contract, one config
// key (`data_extraction_model`) behind /api/ai/config/data-extraction-model.
//
// Why it exists: an automation's Extract data step is not a chat. It wants one
// small, fast, deterministic model — thinking off, temperature 0, a schema it
// cannot wander from — whatever tier the automation around it uses. Without this
// key it would inherit the Fast tier, which on a self-hosted box is often the
// 26B chat model. Unset falls back to the Fast tier's model; the ai_step
// override next to it is a separate lever and stays as it is.
import React from 'react';
import ModelSettingRow from './ModelSettingRow';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { useTranslation } from '@/hooks/useTranslation';

interface DataExtractionModelSectionProps extends ModelPickerSource {
    dataExtractionModel: ModelSetting['model'];
    setDataExtractionModel: ModelSetting['setModel'];
    dataExtractionModelSaving: ModelSetting['saving'];
    dataExtractionModelMessage: ModelSetting['message'];
    saveDataExtractionModel: ModelSetting['save'];
}

export default function DataExtractionModelSection({
    dataExtractionModel, setDataExtractionModel, dataExtractionModelSaving, dataExtractionModelMessage,
    saveDataExtractionModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}: DataExtractionModelSectionProps) {
    const { t } = useTranslation();
    return (
        <ModelSettingRow
            title={t('admin_ai_config.tier_dx_title', 'Data Extraction Model')}
            hint={t('admin_ai_config.tier_dx_hint', 'The model every Data extraction step in an automation runs on, whatever tier the automation itself uses: one small call per document, thinking off, temperature zero, answering in a fixed set of fields. Pick a small, fast model here; a large chat model gains nothing on this job and holds the slot. Unset falls back to the Fast tier\'s model.')}
            emptyLabel={t('admin_ai_config.tier_use_fast', '— Use Fast tier model —')}
            saveLabel={t('admin_ai_config.tier_dx_save', 'Save Data Extraction Model')}
            model={dataExtractionModel}
            setModel={setDataExtractionModel}
            saving={dataExtractionModelSaving}
            message={dataExtractionModelMessage}
            save={saveDataExtractionModel}
            chatModels={chatModels}
            byProvider={byProvider}
            hiddenModelIds={hiddenModelIds}
            toggleHiddenModel={toggleHiddenModel}
        />
    );
}
