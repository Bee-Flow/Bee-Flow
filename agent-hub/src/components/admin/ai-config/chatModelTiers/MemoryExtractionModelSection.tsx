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
import type { ModelPickerSource } from './modelPicker.types';
import type { ModelSetting } from './useModelSetting';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import Section from '@/components/shared/Section';
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
            <Section title={t('admin_ai_config.tier_mem_title', 'Memory Extraction Model')} description={t('admin_ai_config.tier_mem_hint', 'Model that reads each finished exchange for facts worth remembering: a small background call after every reply, thinking off. On a self-hosted single-slot server pick a tiny model here so extraction never queues in front of the next turn. Defaults to the Fast tier model when unset.')}>

                {memoryModelMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${memoryModelMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {memoryModelMessage.text}
                    </div>
                )}

                <div>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide text-[var(--text-muted)]">
                        {t('admin_ai_config.tier_mem_label', 'Memory extraction model')}
                    </label>
                    {(() => {
                        const selected = chatModels.find(m => m.id === memoryModel);
                        const display = selected ? getModelDisplayName(selected) : null;
                        const label = selected
                            ? (display !== selected.id ? display : selected.id)
                            : t('admin_ai_config.tier_use_fast', '— Use Fast tier model —');
                        return (
                            <SearchableModelSelect
                                value={memoryModel || ''}
                                label={label}
                                groups={byProvider}
                                onChange={({ modelId }) => setMemoryModel(modelId || '')}
                                hiddenIds={hiddenModelIds}
                                onToggleHidden={toggleHiddenModel}
                            />
                        );
                    })()}
                </div>

                <button
                    onClick={() => saveMemoryModel()}
                    disabled={memoryModelSaving}
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50 bg-[var(--accent-primary)]"
                >
                    {memoryModelSaving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_mem_save', 'Save Memory Extraction Model')}
                </button>
            </Section>
    );
}
