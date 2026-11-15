// One single-model setting as a row of the "Background models" lists: what it
// is on the left, the model picker on the right. Part of the Models page's one
// draft: a pick changes the draft, the page's save bar stores it.
import type { ReactNode } from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { SettingRow } from '@/components/shared/SettingsList';

interface ModelSettingRowProps extends ModelPickerSource {
    title: ReactNode;
    hint: ReactNode;
    /** What the picker reads while nothing is chosen. */
    emptyLabel: string;
    setting: Pick<ModelSetting, 'model' | 'setModel'>;
}

export default function ModelSettingRow({
    title, hint, emptyLabel, setting, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}: ModelSettingRowProps) {
    const selected = chatModels.find(m => m.id === setting.model);
    const display = selected ? getModelDisplayName(selected) : null;
    const label = selected ? (display !== selected.id ? display : selected.id) : emptyLabel;
    return (
        <SettingRow label={title} hint={hint}>
            <SearchableModelSelect
                value={setting.model || ''}
                label={label}
                groups={byProvider}
                onChange={({ modelId }) => setting.setModel(modelId || '')}
                hiddenIds={hiddenModelIds}
                onToggleHidden={toggleHiddenModel}
            />
        </SettingRow>
    );
}
