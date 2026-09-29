// Compact EU model picker for a custom tier — lives inside the EU section.
// Subtree moved verbatim from ChatModelTiersConfig.jsx's
// renderCustomTierEuRow(); all bindings are threaded in as props.
import React from 'react';
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';

export default function CustomTierEuRow({
    tier, chatModels, byProvider, hiddenModelIds, toggleHiddenModel, updateCustomTier,
}) {
        const selectedModel = chatModels.find(m => m.id === tier.euModelId);
        const displayName = selectedModel ? getModelDisplayName(selectedModel) : null;
        const label = selectedModel
            ? (displayName !== selectedModel.id ? displayName : selectedModel.id)
            : '— Not configured —';
        return (
            <div key={tier.id} className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                <div className="p-4">
                    <div className="flex items-center gap-3 mb-3">
                        <span className="text-xl">{tier.icon || '✨'}</span>
                        <div className="flex-1">
                            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{tier.label}</span>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {tier.description || <span className="italic opacity-60">Custom tier</span>}
                            </p>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(234, 179, 8, 0.2)', color: '#eab308' }}>custom</span>
                    </div>
                    <SearchableModelSelect
                        value={tier.euModelId || ''}
                        label={label}
                        groups={byProvider}
                        onChange={({ modelId }) => updateCustomTier(tier.id, { euModelId: modelId })}
                        hiddenIds={hiddenModelIds}
                        onToggleHidden={toggleHiddenModel}
                    />
                </div>
            </div>
        );
}
