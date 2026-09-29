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
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';

export default function MemoryExtractionModelSection({
    memoryModel, setMemoryModel, memoryModelSaving, memoryModelMessage,
    saveMemoryModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}) {
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(139, 92, 246, 0.15)' }}>🧠</div>
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Memory Extraction Model</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Model that reads each finished exchange for facts worth remembering — a small background call after every reply, thinking off. On a self-hosted single-slot server pick a tiny model here so extraction never queues in front of the next turn. Defaults to the Fast tier model when unset.
                        </p>
                    </div>
                </div>

                {memoryModelMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${memoryModelMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {memoryModelMessage.text}
                    </div>
                )}

                <div className="rounded-xl border p-4" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        Memory extraction model
                    </label>
                    {(() => {
                        const selected = chatModels.find(m => m.id === memoryModel);
                        const display = selected ? getModelDisplayName(selected) : null;
                        const label = selected
                            ? (display !== selected.id ? display : selected.id)
                            : '— Use Fast tier model —';
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
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {memoryModelSaving ? 'Saving...' : 'Save Memory Extraction Model'}
                </button>
            </div>
    );
}
