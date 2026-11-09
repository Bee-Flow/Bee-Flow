// "Auto-tier Classifier Model" section of ChatModelTiersConfig. Subtree moved
// verbatim from ChatModelTiersConfig.jsx; all bindings are threaded in as
// props.
import React from 'react';
import ModelSettingRow from './ModelSettingRow';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { useTranslation } from '@/hooks/useTranslation';

interface ClassifierModelSectionProps extends ModelPickerSource {
    classifierModel: ModelSetting['model'];
    setClassifierModel: ModelSetting['setModel'];
    classifierSaving: ModelSetting['saving'];
    classifierMessage: ModelSetting['message'];
    saveClassifierModel: ModelSetting['save'];
}

export default function ClassifierModelSection({
    classifierModel, setClassifierModel, classifierSaving, classifierMessage,
    saveClassifierModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}: ClassifierModelSectionProps) {
    const { t } = useTranslation();
    return (
        <ModelSettingRow
            title={t('admin_ai_config.tier_cls_title', 'Auto-tier Classifier Model')}
            hint={t('admin_ai_config.tier_cls_hint', 'Picks the model used to classify Auto-tier prompts. Choose the cheapest, fastest model: classification only needs ~8 tokens of output. Defaults to the Fast tier model when unset.')}
            emptyLabel={t('admin_ai_config.tier_use_fast', '— Use Fast tier model —')}
            saveLabel={t('admin_ai_config.tier_cls_save', 'Save Classifier Model')}
            model={classifierModel}
            setModel={setClassifierModel}
            saving={classifierSaving}
            message={classifierMessage}
            save={saveClassifierModel}
            chatModels={chatModels}
            byProvider={byProvider}
            hiddenModelIds={hiddenModelIds}
            toggleHiddenModel={toggleHiddenModel}
        />
    );
}
