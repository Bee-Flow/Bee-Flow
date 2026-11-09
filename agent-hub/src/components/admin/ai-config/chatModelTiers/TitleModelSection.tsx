// "Title Generation Model" section of ChatModelTiersConfig. Subtree moved
// verbatim from ChatModelTiersConfig.jsx; all bindings are threaded in as
// props.
import React from 'react';
import ModelSettingRow from './ModelSettingRow';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { useTranslation } from '@/hooks/useTranslation';

interface TitleModelSectionProps extends ModelPickerSource {
    titleModel: ModelSetting['model'];
    setTitleModel: ModelSetting['setModel'];
    titleModelSaving: ModelSetting['saving'];
    titleModelMessage: ModelSetting['message'];
    saveTitleModel: ModelSetting['save'];
}

export default function TitleModelSection({
    titleModel, setTitleModel, titleModelSaving, titleModelMessage,
    saveTitleModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}: TitleModelSectionProps) {
    const { t } = useTranslation();
    return (
        <ModelSettingRow
            title={t('admin_ai_config.tier_title_title', 'Title Generation Model')}
            hint={t('admin_ai_config.tier_title_hint', 'Model used to name conversations: a tiny, tool-free call made after the second reply. Pick the cheapest, fastest model so a heavy Fast tier doesn\'t make titling expensive. Defaults to the Fast tier model when unset.')}
            emptyLabel={t('admin_ai_config.tier_use_fast', '— Use Fast tier model —')}
            saveLabel={t('admin_ai_config.tier_title_save', 'Save Title Model')}
            model={titleModel}
            setModel={setTitleModel}
            saving={titleModelSaving}
            message={titleModelMessage}
            save={saveTitleModel}
            chatModels={chatModels}
            byProvider={byProvider}
            hiddenModelIds={hiddenModelIds}
            toggleHiddenModel={toggleHiddenModel}
        />
    );
}
