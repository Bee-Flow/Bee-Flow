// Shared searchable model picker — trigger button + full-screen overlay
// with a search box and provider/family filter chips. Replaces the
// near-identical SearchableModelSelect components that were open-coded in
// ChatModelTiersConfig and AIConfig/WebSearchInferenceConfig (the merge is
// a superset: the WebSearch copy's extra Claude/Gemini family detection AND
// the tiers copy's hidden-model management both live here now).
//
// Usage:
//   <SearchableModelSelect
//       value={modelId /* or { providerId, modelId } for provider-scoped selection */}
//       label={triggerLabel}
//       groups={{ 'Provider name': [{ id, providerId, name }, ...] }}
//       onChange={({ providerId, modelId }) => ...}  // empty strings = cleared
//       title="Select Model"                          // optional overlay heading
//       clearLabel="— Not configured —"               // optional clear-row label
//       hiddenIds={hiddenModelIds}                    // optional: ids to hide
//       onToggleHidden={(modelId) => ...}             // optional: show hide/unhide UI
//   />

import React, { useState, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { getModelMeta, getModelFamily } from '@/api/modelMeta';
import Modal from '../../shared/Modal';
import { FilterChips, ModelRow, type SelectableModel } from './SearchableModelSelectParts';
import { useTranslation } from '@/hooks/useTranslation';


interface ModelSelection {
    providerId: string;
    modelId: string;
}

interface SearchableModelSelectProps {
    value?: string | { providerId?: string; modelId?: string } | null;
    label: ReactNode;
    groups: Record<string, SelectableModel[]>;
    onChange: (selection: ModelSelection) => void;
    title?: string;
    clearLabel?: string;
    hiddenIds?: string[];
    onToggleHidden?: (modelId: string) => void;
}

const SearchableModelSelect = ({
    value,
    label,
    groups,
    onChange,
    title = undefined,
    clearLabel = undefined,
    hiddenIds = [],
    onToggleHidden,
}: SearchableModelSelectProps) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [activeProvider, setActiveProvider] = useState<string | null>(null);   // null = all
    const [activeFamily, setActiveFamily] = useState<string | null>(null);       // null = all
    const [showHidden, setShowHidden] = useState(false);
    // The search field takes the focus when the picker opens (Modal's
    // initialFocus), not the first control, the ✕.
    const inputRef = useRef<HTMLInputElement>(null);
    const titleId = useId();

    // `value` is either a raw model id string or { providerId, modelId }.
    const selectedId = typeof value === 'string' ? value : (value?.modelId || '');
    const selectedProviderId = typeof value === 'string' ? '' : (value?.providerId || '');
    const hiddenSet = new Set(hiddenIds);

    // Build provider list and family list from all models
    const providerNames = Object.keys(groups);
    const allFamilies = new Set<string>();
    Object.values(groups).flat().forEach(m => allFamilies.add(getModelFamily(m.id)));
    const familyList = [...allFamilies].sort();

    // Filter models by search + provider + family + hidden state
    const lowerSearch = search.toLowerCase();
    const filteredGroups: Record<string, SelectableModel[]> = {};
    Object.entries(groups).forEach(([provName, models]) => {
        // Provider filter
        if (activeProvider && provName !== activeProvider) return;
        const filtered = models.filter(m => {
            // Hidden filter — always show the currently selected model so
            // the picker doesn't lie about its own state, but otherwise
            // hide blocked models unless "Show hidden" is on.
            if (hiddenSet.has(m.id) && m.id !== selectedId && !showHidden) return false;
            // Family filter
            if (activeFamily && getModelFamily(m.id) !== activeFamily) return false;
            // Text search
            if (!lowerSearch) return true;
            const meta = getModelMeta(m.id);
            // Self-hosted models aren't in the bundled metadata table — the
            // server derives their label and category, so fall back to those.
            const name = meta?.name || m.name || '';
            const cat = meta?.cat || m.cat || '';
            return m.id.toLowerCase().includes(lowerSearch)
                || name.toLowerCase().includes(lowerSearch)
                || cat.toLowerCase().includes(lowerSearch);
        });
        if (filtered.length > 0) filteredGroups[provName] = filtered;
    });
    const totalResults = Object.values(filteredGroups).reduce((s, a) => s + a.length, 0);
    const hiddenCount = hiddenIds.length;

    return (
        <>
            {/* Trigger button */}
            <SearchableModelSelectSection setOpen={setOpen} setSearch={setSearch} setActiveProvider={setActiveProvider} setActiveFamily={setActiveFamily} selectedId={selectedId} label={label} />

            {/* The picker, through the shared Modal: Escape and a press on the
                backdrop close it (useOutsideDismiss did that before), Tab stays
                inside, focus returns to the trigger. */}
            <Modal
                open={open}
                onClose={() => setOpen(false)}
                variant="bare"
                size="lg"
                zIndex={9999}
                labelledBy={titleId}
                initialFocus={inputRef}
            >
                <div
                    className="w-full rounded-2xl border shadow-2xl flex flex-col"
                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', maxHeight: '80vh' }}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 pt-5 pb-3">
                        <div>
                            <h3 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">{title ?? t('admin_shared.model_select_title', 'Select Model')}</h3>
                            <p className="text-xs mt-0.5 text-[var(--text-muted)]">
                                {search
                                    ? (totalResults === 1 ? t('admin_shared.model_select_count_match_one', '{count} model matching "{search}"', { count: totalResults, search }) : t('admin_shared.model_select_count_match_many', '{count} models matching "{search}"', { count: totalResults, search }))
                                    : (totalResults === 1 ? t('admin_shared.model_select_count_one', '{count} model available', { count: totalResults }) : t('admin_shared.model_select_count_many', '{count} models available', { count: totalResults }))}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors text-[var(--text-muted)]"
                        >
                            ✕
                        </button>
                    </div>

                    {/* Search input */}
                    <div className="px-5 pb-3">
                        <div className="relative">
                            <svg className="absolute left-3 top-3 w-5 h-5 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <input
                                ref={inputRef}
                                type="text"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder={t('admin_shared.model_select_search_ph', 'Search by name, ID, or category...')}
                                className="w-full pl-10 pr-4 py-2.5 rounded-xl border outline-none text-sm"
                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            />
                        </div>
                    </div>

                    {/* Filter chips */}
                    <FilterChips
                        t={t} providerNames={providerNames} activeProvider={activeProvider} setActiveProvider={setActiveProvider}
                        familyList={familyList} activeFamily={activeFamily} setActiveFamily={setActiveFamily}
                        hiddenCount={hiddenCount} canToggleHidden={!!onToggleHidden} showHidden={showHidden} setShowHidden={setShowHidden}
                    />

                    {/* Model list */}
                    <div className="flex-1 overflow-y-auto px-2 pb-4 [min-height:0]">
                        {/* Clear option */}
                        <button
                            type="button"
                            onClick={() => { onChange({ providerId: '', modelId: '' }); setOpen(false); }}
                            className="w-full text-left px-4 py-2.5 rounded-lg text-sm hover:bg-white/5 transition-colors mb-1 text-[var(--text-muted)]"
                        >
                            {clearLabel ?? `— ${t('admin_shared.model_select_not_configured', 'Not configured')} —`}
                        </button>

                        {Object.entries(filteredGroups).map(([provName, models]) => (
                            <div key={provName} className="mb-2">
                                {/* Provider header */}
                                <div
                                    className="sticky top-0 z-10 px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-lg mb-1"
                                    style={{ background: 'var(--bg-secondary)', color: 'var(--accent-primary)' }}
                                >
                                    {provName} ({models.length})
                                </div>
                                <div className="grid gap-0.5">
                                    {models.map(m => (
                                        <ModelRow
                                            key={(m.providerId || '') + ':' + m.id}
                                            t={t} m={m} isHidden={hiddenSet.has(m.id)}
                                            isSelected={m.id === selectedId && (!selectedProviderId || m.providerId === selectedProviderId)}
                                            onPick={() => { onChange({ providerId: m.providerId || '', modelId: m.id }); setOpen(false); }}
                                            onToggleHidden={onToggleHidden}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}

                        {totalResults === 0 && (
                            <div className="px-4 py-12 text-center text-[var(--text-muted)]">
                                <p className="text-lg mb-1">{t('admin_shared.model_select_no_models', 'No models found')}</p>
                                <p className="text-sm">{providerNames.length === 0 ? t('admin_shared.model_select_no_provider', 'Configure a provider in the Providers tab first.') : t('admin_shared.model_select_try_other', 'Try a different search term')}</p>
                            </div>
                        )}
                    </div>
                </div>
            </Modal>
        </>
    );
};

export default SearchableModelSelect;

function SearchableModelSelectSection({ setOpen, setSearch, setActiveProvider, setActiveFamily, selectedId, label }: { setOpen: React.Dispatch<React.SetStateAction<boolean>>; setSearch: React.Dispatch<React.SetStateAction<string>>; setActiveProvider: React.Dispatch<React.SetStateAction<string | null>>; setActiveFamily: React.Dispatch<React.SetStateAction<string | null>>; selectedId: string; label: React.ReactNode; }) {
    return <button
        type="button"
        onClick={() => { setOpen(true); setSearch(''); setActiveProvider(null); setActiveFamily(null); } }
        className="w-full px-3 py-2.5 rounded-lg border outline-none text-sm text-left flex items-center justify-between transition-colors hover:border-[var(--accent-primary)]"
        style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border-default)',
            color: selectedId ? 'var(--text-primary)' : 'var(--text-muted)',
        }}
    >
        <span className="truncate">{label}</span>
        <svg className="w-4 h-4 shrink-0 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
    </button>;
}
