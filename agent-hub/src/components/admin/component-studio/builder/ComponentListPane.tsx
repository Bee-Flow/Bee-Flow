// The builder's sidebar: New / AI buttons, the search box and the components
// grouped by category (collapsible, with a delete per group and per item).

import { useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { getCategoryIcon } from './componentForm';
import type { ComponentSummary } from './componentForm';

interface ListPaneProps {
    components: ComponentSummary[];
    loading: boolean;
    selectedComponent: string | null;
    onNew: () => void;
    onOpenAI: () => void;
    onSelect: (comp: ComponentSummary) => void;
    onDeleteCategory: (category: string, componentsInCategory: ComponentSummary[]) => void;
    onDeleteOne: (e: MouseEvent, compId: string, compName: string) => void;
}

/** Components whose name or category contains the term, grouped by category. */
function groupComponents(components: ComponentSummary[], searchTerm: string) {
    // Filter components
    const filteredComponents = components.filter(comp => {
        const name = (comp.definition?.name || comp.id).toLowerCase();
        const category = (comp.definition?.category || '').toLowerCase();
        const term = searchTerm.toLowerCase();
        return name.includes(term) || category.includes(term);
    });

    // Group components by category
    const groupedComponents = filteredComponents.reduce<Record<string, ComponentSummary[]>>((acc, comp) => {
        const category = comp.definition?.category || 'Uncategorized';
        if (!acc[category]) acc[category] = [];
        acc[category].push(comp);
        return acc;
    }, {});

    return { groupedComponents, sortedCategories: Object.keys(groupedComponents).sort() };
}

function ListToolbar({ searchTerm, setSearchTerm, onNew, onOpenAI }: { searchTerm: string; setSearchTerm: (v: string) => void; onNew: () => void; onOpenAI: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="p-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
            <div className="flex gap-2 mb-3">
                <button onClick={onNew} className="btn-primary flex-1 justify-center">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    {t('component_studio.builder.new_button', 'New')}
                </button>
                <button onClick={onOpenAI} className="btn-secondary flex-1 justify-center" style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    {t('component_studio.builder.ai_button', 'AI')}
                </button>
            </div>
            <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder={t('component_studio.builder.search_placeholder', 'Search components...')}
                    className="input w-full pl-10"
                />
            </div>
        </div>
    );
}

function ComponentListItem({ comp, icon, selected, onSelect, onDeleteOne }: { comp: ComponentSummary; icon: string; selected: boolean; onSelect: ListPaneProps['onSelect']; onDeleteOne: ListPaneProps['onDeleteOne'] }) {
    const { t } = useTranslation();
    return (
        <div
            onClick={() => onSelect(comp)}
            className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-all group/item ${selected
                ? 'bg-[var(--accent-primary)]'
                : 'hover:bg-[var(--bg-tertiary)]'
                }`}
            style={{
                color: selected ? 'white' : 'var(--text-secondary)',
                marginBottom: '2px'
            }}
        >
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{
                    background: selected ? 'rgba(255,255,255,0.2)' : 'var(--bg-tertiary)',
                    fontSize: '12px'
                }}>
                {icon}
            </div>
            <div className="flex-1 min-w-0">
                <span className="truncate text-sm font-medium block">{comp.definition.name || comp.id}</span>
                {comp.definition.description && (
                    <span
                        className="text-xs truncate block mt-0.5"
                        style={{ color: selected ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)', lineHeight: '1.3' }}
                    >
                        {comp.definition.description.length > 60 ? comp.definition.description.slice(0, 60) + '…' : comp.definition.description}
                    </span>
                )}
            </div>
            <button
                onClick={(e) => onDeleteOne(e, comp.id, comp.definition.name || comp.id)}
                className={`p-1 rounded transition-all hover:bg-red-500/20 flex-shrink-0 ${selected
                    ? 'opacity-70 hover:opacity-100'
                    : 'opacity-0 group-hover/item:opacity-100'
                    }`}
                title={t('component_studio.builder.delete_component_title', 'Delete component')}
                style={{ color: selected ? 'white' : '#ef4444' }}
            >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>
        </div>
    );
}

interface CategoryGroupProps {
    category: string;
    items: ComponentSummary[];
    isCollapsed: boolean;
    onToggle: () => void;
    selectedComponent: string | null;
    onSelect: ListPaneProps['onSelect'];
    onDeleteCategory: ListPaneProps['onDeleteCategory'];
    onDeleteOne: ListPaneProps['onDeleteOne'];
}

function CategoryGroup({ category, items, isCollapsed, onToggle, selectedComponent, onSelect, onDeleteCategory, onDeleteOne }: CategoryGroupProps) {
    const { t } = useTranslation();
    const catInfo = getCategoryIcon(category);
    return (
        <div className="mb-3">
            <div
                className="flex items-center gap-2 px-2 py-1.5 mb-1 group cursor-pointer select-none rounded-lg transition-colors hover:bg-[var(--bg-tertiary)]"
                onClick={onToggle}
            >
                <svg
                    className="w-3 h-3 transition-transform flex-shrink-0"
                    style={{ color: 'var(--text-muted)', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                <span style={{ fontSize: '12px' }}>{catInfo.icon}</span>
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    {category}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded-full"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)', fontSize: '10px' }}>
                    {items.length}
                </span>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDeleteCategory(category, items);
                    }}
                    className="ml-auto opacity-0 group-hover:opacity-100 p-1 rounded transition-all hover:bg-red-500/20"
                    title={t('component_studio.builder.delete_category_title', 'Delete all {count} components in {category}', { count: items.length, category })}
                    style={{ color: '#ef4444' }}
                >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                </button>
            </div>
            {!isCollapsed && items.map(comp => (
                <ComponentListItem
                    key={comp.id}
                    comp={comp}
                    icon={catInfo.icon}
                    selected={selectedComponent === comp.id}
                    onSelect={onSelect}
                    onDeleteOne={onDeleteOne}
                />
            ))}
        </div>
    );
}

export default function ComponentListPane({ components, loading, selectedComponent, onNew, onOpenAI, onSelect, onDeleteCategory, onDeleteOne }: ListPaneProps) {
    const { t } = useTranslation();
    const [searchTerm, setSearchTerm] = useState('');
    const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
    const { groupedComponents, sortedCategories } = groupComponents(components, searchTerm);

    return (
        <div className="w-80 border-r flex flex-col" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
            <ListToolbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} onNew={onNew} onOpenAI={onOpenAI} />

            <div className="flex-1 overflow-auto p-2">
                {loading ? (
                    <div className="flex justify-center py-8">
                        <div className="spinner"></div>
                    </div>
                ) : sortedCategories.length === 0 ? (
                    <div className="text-center py-8 text-muted text-sm">{t('component_studio.builder.no_components', 'No components found')}</div>
                ) : (
                    sortedCategories.map(category => (
                        <CategoryGroup
                            key={category}
                            category={category}
                            items={groupedComponents[category]}
                            isCollapsed={collapsedCategories[category]}
                            onToggle={() => setCollapsedCategories(prev => ({ ...prev, [category]: !prev[category] }))}
                            selectedComponent={selectedComponent}
                            onSelect={onSelect}
                            onDeleteCategory={onDeleteCategory}
                            onDeleteOne={onDeleteOne}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
