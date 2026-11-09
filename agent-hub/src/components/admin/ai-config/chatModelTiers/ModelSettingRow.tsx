// One single-model setting as a row of the "Background models" list: what it
// is on the left, the model picker and its own Save on the right. The five
// *ModelSection files bind it to their ModelSetting.
import type { ReactNode } from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { SettingRow, SAVE_BUTTON } from '@/components/shared/SettingsList';
import { useToastOnMessage } from '../ui/useToastOnMessage';
import { useTranslation } from '@/hooks/useTranslation';

interface ModelSettingRowProps extends ModelPickerSource {
    title: ReactNode;
    hint: ReactNode;
    /** What the picker reads while nothing is chosen. */
    emptyLabel: string;
    saveLabel: string;
    model: ModelSetting['model'];
    setModel: ModelSetting['setModel'];
    saving: ModelSetting['saving'];
    message: ModelSetting['message'];
    save: ModelSetting['save'];
}

export default function ModelSettingRow({
    title, hint, emptyLabel, saveLabel, model, setModel, saving, message, save,
    chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}: ModelSettingRowProps) {
    const { t } = useTranslation();
    useToastOnMessage(message);
    const selected = chatModels.find(m => m.id === model);
    const display = selected ? getModelDisplayName(selected) : null;
    const label = selected ? (display !== selected.id ? display : selected.id) : emptyLabel;
    return (
        <SettingRow label={title} hint={hint}>
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <SearchableModelSelect
                        value={model || ''}
                        label={label}
                        groups={byProvider}
                        onChange={({ modelId }) => setModel(modelId || '')}
                        hiddenIds={hiddenModelIds}
                        onToggleHidden={toggleHiddenModel}
                    />
                </div>
                <button type="button" onClick={() => save()} disabled={saving} className={SAVE_BUTTON}>
                    {saving ? t('admin_ai_config.saving', 'Saving...') : saveLabel}
                </button>
            </div>
        </SettingRow>
    );
}
