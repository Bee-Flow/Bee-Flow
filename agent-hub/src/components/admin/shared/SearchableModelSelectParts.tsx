import type React from 'react';
import { getModelMeta, getModelDisplayName } from '@/api/modelMeta';
import type { ModelEntry } from '@/api/modelMeta';
import type { TranslateFn } from '@/hooks/useTranslation';

// The filter chips and the model rows of SearchableModelSelect.

/** A model the picker lists; the provider id tells two hosts of one model apart. */
export interface SelectableModel extends ModelEntry {
    providerId?: string;
}

interface FilterChipsProps {
    t: TranslateFn;
    providerNames: string[];
    activeProvider: string | null;
    setActiveProvider: (provider: string | null) => void;
    familyList: string[];
    activeFamily: string | null;
    setActiveFamily: (family: string | null) => void;
    hiddenCount: number;
    canToggleHidden: boolean;
    showHidden: boolean;
    setShowHidden: React.Dispatch<React.SetStateAction<boolean>>;
}

/** The provider, hidden and family chips above the list. */
export function FilterChips({
    t, providerNames, activeProvider, setActiveProvider, familyList, activeFamily, setActiveFamily, hiddenCount, canToggleHidden, showHidden, setShowHidden,
}: FilterChipsProps) {
    return (
        <div className="px-5 pb-3 space-y-2">
            {/* Provider filter */}
            <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-semibold uppercase tracking-wider mr-1 text-[var(--text-muted)]">{t('admin_shared.model_select_provider', 'Provider')}</span>
                <button
                    type="button"
                    onClick={() => setActiveProvider(null)}
                    className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                    style={{
                        background: !activeProvider ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                        color: !activeProvider ? '#fff' : 'var(--text-muted)',
                    }}
                >{t('admin_shared.model_select_all', 'All')}</button>
                {providerNames.map(p => (
                    <button
                        key={p}
                        type="button"
                        onClick={() => setActiveProvider(activeProvider === p ? null : p)}
                        className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                        style={{
                            background: activeProvider === p ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                            color: activeProvider === p ? '#fff' : 'var(--text-muted)',
                        }}
                    >{p}</button>
                ))}
            </div>
            {/* Hidden toggle — only render when there's something to manage */}
            {(hiddenCount > 0 || canToggleHidden) && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-semibold uppercase tracking-wider mr-1 text-[var(--text-muted)]">{t('admin_shared.model_select_hidden', 'Hidden')}</span>
                    <button
                        type="button"
                        onClick={() => setShowHidden(s => !s)}
                        className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                        style={{
                            background: showHidden ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                            color: showHidden ? '#fff' : 'var(--text-muted)',
                        }}
                        title={hiddenCount === 0 ? t('admin_shared.model_select_none_hidden', 'No models hidden yet') : hiddenCount === 1 ? t('admin_shared.model_select_hidden_one', '{count} model hidden', { count: hiddenCount }) : t('admin_shared.model_select_hidden_many', '{count} models hidden', { count: hiddenCount })}
                    >
                        {showHidden ? t('admin_shared.model_select_showing_hidden', 'Showing hidden ({count})', { count: hiddenCount }) : t('admin_shared.model_select_show_hidden', 'Show hidden ({count})', { count: hiddenCount })}
                    </button>
                </div>
            )}
            {/* Family filter */}
            {familyList.length > 1 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-semibold uppercase tracking-wider mr-1 text-[var(--text-muted)]">{t('admin_shared.model_select_family', 'Family')}</span>
                    <button
                        type="button"
                        onClick={() => setActiveFamily(null)}
                        className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                        style={{
                            background: !activeFamily ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                            color: !activeFamily ? '#fff' : 'var(--text-muted)',
                        }}
                    >{t('admin_shared.model_select_all', 'All')}</button>
                    {familyList.map(f => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => setActiveFamily(activeFamily === f ? null : f)}
                            className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                            style={{
                                background: activeFamily === f ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                color: activeFamily === f ? '#fff' : 'var(--text-muted)',
                            }}
                        >{f}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

interface ModelRowProps {
    t: TranslateFn;
    m: SelectableModel;
    isSelected: boolean;
    isHidden: boolean;
    onPick: () => void;
    onToggleHidden: ((modelId: string) => void) | undefined;
}

/** One model in the picker: tick, name (and id), category, and the hide/unhide toggle. */
export function ModelRow({ t, m, isSelected, isHidden, onPick, onToggleHidden }: ModelRowProps) {
    const meta = getModelMeta(m.id);
    const displayName = getModelDisplayName(m);
    // Local models carry their category on the model itself.
    const cat = meta?.cat || m.cat || '';
    return (
        <div
            className={`w-full rounded-lg text-sm flex items-stretch transition-all ${isSelected
                ? 'ring-1 ring-[var(--accent-primary)]'
                : 'hover:bg-white/5'
                }`}
            style={{
                background: isSelected ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                color: 'var(--text-primary)',
                opacity: isHidden ? 0.55 : 1,
            }}
        >
            <button
                type="button"
                onClick={onPick}
                className="flex-1 min-w-0 text-left px-4 py-2.5 flex items-center gap-3"
            >
                {/* Checkmark */}
                <span className="w-5 text-center shrink-0 text-[var(--accent-primary)]">
                    {isSelected ? '✓' : ''}
                </span>
                {/* Model info */}
                <div className="flex-1 min-w-0">
                    <div className="font-medium flex items-center gap-2">
                        <span className="truncate">{displayName}</span>
                        {isHidden && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{t('admin_shared.model_select_hidden', 'Hidden')}</span>
                        )}
                    </div>
                    {displayName !== m.id && (
                        <div className="text-xs mt-0.5 truncate text-[var(--text-muted)]">{m.id}</div>
                    )}
                </div>
                {/* Category badge */}
                {cat && (
                    <span
                        className="text-[10px] px-2 py-1 rounded-full shrink-0 font-medium bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                    >
                        {cat}
                    </span>
                )}
            </button>
            {/* Hide / unhide toggle */}
            {onToggleHidden && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onToggleHidden(m.id); }}
                    className="px-3 flex items-center justify-center hover:bg-white/10 rounded-r-lg transition-colors shrink-0 text-[var(--text-muted)]"
                    title={isHidden ? t('admin_shared.model_select_show_in_tiers', 'Show this model in tier pickers') : t('admin_shared.model_select_hide_from_tiers', 'Hide this model from tier pickers')}
                >
                    {isHidden ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                    ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                    )}
                </button>
            )}
        </div>
    );
}
