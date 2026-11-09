// "Auto-tier Classifier Model" section of ChatModelTiersConfig. Subtree moved
// verbatim from ChatModelTiersConfig.jsx; all bindings are threaded in as
// props.
import React from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import Section from '@/components/shared/Section';
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
            <Section title={t('admin_ai_config.tier_cls_title', 'Auto-tier Classifier Model')} description={t('admin_ai_config.tier_cls_hint', 'Picks the model used to classify Auto-tier prompts. Choose the cheapest, fastest model: classification only needs ~8 tokens of output. Defaults to the Fast tier model when unset.')}>

                {classifierMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${classifierMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {classifierMessage.text}
                    </div>
                )}

                <div>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide text-[var(--text-muted)]">
                        {t('admin_ai_config.tier_cls_label', 'Classifier model')}
                    </label>
                    {(() => {
                        const selected = chatModels.find(m => m.id === classifierModel);
                        const display = selected ? getModelDisplayName(selected) : null;
                        const label = selected
                            ? (display !== selected.id ? display : selected.id)
                            : t('admin_ai_config.tier_use_fast', '— Use Fast tier model —');
                        return (
                            <SearchableModelSelect
                                value={classifierModel || ''}
                                label={label}
                                groups={byProvider}
                                onChange={({ modelId }) => setClassifierModel(modelId || '')}
                                hiddenIds={hiddenModelIds}
                                onToggleHidden={toggleHiddenModel}
                            />
                        );
                    })()}
                </div>

                <button
                    onClick={() => saveClassifierModel()}
                    disabled={classifierSaving}
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50 bg-[var(--accent-primary)]"
                >
                    {classifierSaving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_cls_save', 'Save Classifier Model')}
                </button>
            </Section>
    );
}
