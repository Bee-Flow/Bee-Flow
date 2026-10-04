// "AI Step Model" section of ChatModelTiersConfig — a TEMPORARY override.
// Mirrors MemoryExtractionModelSection: same layout, same prop contract, one
// config key (`ai_step_model`) behind /api/ai/config/ai-step-model.
//
// Why it exists: an automation's ai_step inherits the Auto/Fast tier the builder
// writes for it. On a single-slot self-hosted server that is the model the
// builder itself runs on, so a dry run with a few AI steps evicts the
// builder's prompt cache and queues full prompt evaluations before the next
// round. Pointing the default tier at a tiny model keeps a demo build warm.
// Explicit heavier tiers are untouched (core/automationRunner/aiStepModel.js).
import React from 'react';
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';

export default function AiStepModelSection({
    aiStepModel, setAiStepModel, aiStepModelSaving, aiStepModelMessage,
    saveAiStepModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}) {
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(245, 158, 11, 0.15)' }}>🪄</div>
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>AI Step Model (temporary override)</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Model every automation AI step runs on when the step asks for Auto or Fast, the tiers the builder writes by default. Temporary switch: on a self-hosted single-slot server it keeps a dry run from evicting the builder's prompt cache on the big model. Steps that explicitly pick Thinking or another tier keep their own model. Unset = the step's own tier, as before.
                        </p>
                    </div>
                </div>

                {aiStepModelMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${aiStepModelMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {aiStepModelMessage.text}
                    </div>
                )}

                <div className="rounded-xl border p-4" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        AI step model
                    </label>
                    {(() => {
                        const selected = chatModels.find(m => m.id === aiStepModel);
                        const display = selected ? getModelDisplayName(selected) : null;
                        const label = selected
                            ? (display !== selected.id ? display : selected.id)
                            : "— Use the step's own tier —";
                        return (
                            <SearchableModelSelect
                                value={aiStepModel || ''}
                                label={label}
                                groups={byProvider}
                                onChange={({ modelId }) => setAiStepModel(modelId || '')}
                                hiddenIds={hiddenModelIds}
                                onToggleHidden={toggleHiddenModel}
                            />
                        );
                    })()}
                </div>

                <button
                    onClick={() => saveAiStepModel()}
                    disabled={aiStepModelSaving}
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {aiStepModelSaving ? 'Saving...' : 'Save AI Step Model'}
                </button>
            </div>
    );
}
