// "Title Generation Model" section of ChatModelTiersConfig. Subtree moved
// verbatim from ChatModelTiersConfig.jsx; all bindings are threaded in as
// props.
import React from 'react';
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';

export default function TitleModelSection({
    titleModel, setTitleModel, titleModelSaving, titleModelMessage,
    saveTitleModel, chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
}) {
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(245, 158, 11, 0.15)' }}>🏷️</div>
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Title Generation Model</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Model used to name conversations — a tiny, tool-free call made after the second reply. Pick the cheapest, fastest model so a heavy Fast tier doesn't make titling expensive. Defaults to the Fast tier model when unset.
                        </p>
                    </div>
                </div>

                {titleModelMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${titleModelMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {titleModelMessage.text}
                    </div>
                )}

                <div className="rounded-xl border p-4" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                    <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        Title model
                    </label>
                    {(() => {
                        const selected = chatModels.find(m => m.id === titleModel);
                        const display = selected ? getModelDisplayName(selected) : null;
                        const label = selected
                            ? (display !== selected.id ? display : selected.id)
                            : '— Use Fast tier model —';
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
                    className="mt-4 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {titleModelSaving ? 'Saving...' : 'Save Title Model'}
                </button>
            </div>
    );
}
