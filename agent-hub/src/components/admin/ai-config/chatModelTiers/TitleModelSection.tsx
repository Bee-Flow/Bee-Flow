// "Title Generation Model" section of ChatModelTiersConfig. Subtree moved
// verbatim from ChatModelTiersConfig.jsx; all bindings are threaded in as
// props.
import React from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import Section from '@/components/shared/Section';
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
            <Section title={t('admin_ai_config.tier_title_title', 'Title Generation Model')} description={t('admin_ai_config.tier_title_hint', 'Model used to name conversations: a tiny, tool-free call made after the second reply. Pick the cheapest, fastest model so a heavy Fast tier doesn\'t make titling expensive. Defaults to the Fast tier model when unset.')}>

                {titleModelMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${titleModelMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {titleModelMessage.text}
                    </div>
                )}

                <div>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide text-[var(--text-muted)]">
                        {t('admin_ai_config.tier_title_label', 'Title model')}
                    </label>
                    {(() => {
                        const selected = chatModels.find(m => m.id === titleModel);
                        const display = selected ? getModelDisplayName(selected) : null;
                        const label = selected
                            ? (display !== selected.id ? display : selected.id)
                            : t('admin_ai_config.tier_use_fast', '— Use Fast tier model —');
                        return (
                            <SearchableModelSelect
                                value={titleModel || ''}
                                label={label}
                                groups={byProvider}
                                onChange={({ modelId }) => setTitleModel(modelId || '')}
                                hiddenIds={hiddenModelIds}
                                onToggleHidden={toggleHiddenModel}
                            />
                        );
                    })()}
                </div>

                <button
                    onClick={() => saveTitleModel()}
                    disabled={titleModelSaving}
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50 bg-[var(--accent-primary)]"
                >
                    {titleModelSaving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_title_save', 'Save Title Model')}
                </button>
            </Section>
    );
}
