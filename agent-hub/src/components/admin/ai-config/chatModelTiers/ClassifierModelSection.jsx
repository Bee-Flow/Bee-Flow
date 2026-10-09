// "Auto-tier Classifier Model" section of ChatModelTiersConfig. Subtree moved
// verbatim from ChatModelTiersConfig.jsx; all bindings are threaded in as
// props.
import React from 'react';
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { useTranslation } from '../../../../hooks/useTranslation';

export default function ClassifierModelSection({
    classifierModel, setClassifierModel, classifierSaving, classifierMessage,
    saveClassifierModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}) {
    const { t } = useTranslation();
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(99, 102, 241, 0.15)' }}>🔀</div>
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_cls_title', 'Auto-tier Classifier Model')}</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {t('admin_ai_config.tier_cls_hint', 'Picks the model used to classify Auto-tier prompts. Choose the cheapest, fastest model: classification only needs ~8 tokens of output. Defaults to the Fast tier model when unset.')}
                        </p>
                    </div>
                </div>

                {classifierMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${classifierMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {classifierMessage.text}
                    </div>
                )}

                <div className="rounded-xl border p-4" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
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
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {classifierSaving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_cls_save', 'Save Classifier Model')}
                </button>
            </div>
    );
}
