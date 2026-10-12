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
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { useTranslation } from '../../../../hooks/useTranslation';

export default function DataExtractionModelSection({
    dataExtractionModel, setDataExtractionModel, dataExtractionModelSaving, dataExtractionModelMessage,
    saveDataExtractionModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}) {
    const { t } = useTranslation();
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(14, 165, 233, 0.15)' }}>🔎</div>
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_dx_title', 'Data Extraction Model')}</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {t('admin_ai_config.tier_dx_hint', 'The model every Data extraction step in an automation runs on, whatever tier the automation itself uses: one small call per document, thinking off, temperature zero, answering in a fixed set of fields. Pick a small, fast model here; a large chat model gains nothing on this job and holds the slot. Unset falls back to the Fast tier\'s model.')}
                        </p>
                    </div>
                </div>

                {dataExtractionModelMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${dataExtractionModelMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {dataExtractionModelMessage.text}
                    </div>
                )}

                <div className="rounded-xl border p-4" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        {t('admin_ai_config.tier_dx_label', 'Data extraction model')}
                    </label>
                    {(() => {
                        const selected = chatModels.find(m => m.id === dataExtractionModel);
                        const display = selected ? getModelDisplayName(selected) : null;
                        const label = selected
                            ? (display !== selected.id ? display : selected.id)
                            : t('admin_ai_config.tier_use_fast', '— Use Fast tier model —');
                        return (
                            <SearchableModelSelect
                                value={dataExtractionModel || ''}
                                label={label}
                                groups={byProvider}
                                onChange={({ modelId }) => setDataExtractionModel(modelId || '')}
                                hiddenIds={hiddenModelIds}
                                onToggleHidden={toggleHiddenModel}
                            />
                        );
                    })()}
                </div>

                <button
                    onClick={() => saveDataExtractionModel()}
                    disabled={dataExtractionModelSaving}
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {dataExtractionModelSaving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_dx_save', 'Save Data Extraction Model')}
                </button>
            </div>
    );
}
