import { Link2, Plug, Plus, Rows3, Share2, Table2, Trash2, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { tableSourceOf } from './tablesManagerModel';
import type { ModelTable, TableSource } from './tablesManagerModel';
import type { ManagerTab } from './useDataModel';
import useTranslation from '@/hooks/useTranslation';

interface TabBarProps {
    activeTab: ManagerTab;
    onTab: (tab: ManagerTab) => void;
    selected: ModelTable | null;
    selectedSaved: unknown;
    selectedSource: TableSource | null;
}

/** Tabs: Tables ↔ Rows ↔ Relationships ↔ Connectors ↔ People — all over the one model. */
export function ManagerTabBar({ activeTab, onTab, selected, selectedSaved, selectedSource }: TabBarProps) {
    const { t } = useTranslation();
    const tabs: Array<{ id: ManagerTab; label: string; Icon: LucideIcon; disabled?: boolean; title?: string }> = [
        { id: 'tables', label: t('studio_apps_tables.manager.tab_tables', 'Tables'), Icon: Table2 },
        {
            id: 'rows',
            label: t('studio_apps_tables.manager.tab_rows', 'Rows'),
            Icon: Rows3,
            disabled: !selectedSaved || !!selectedSource,
            title: selectedSource
                ? t('app_studio.tables.rows_linked_title', 'These rows live in a Studio table — open it there to edit them.')
                : t('studio_apps_tables.manager.rows_unsaved_title', 'Save the table first — until then there is nowhere to keep its rows.'),
        },
        { id: 'relations', label: t('studio_apps_tables.manager.tab_relationships', 'Relationships'), Icon: Share2 },
        { id: 'connectors', label: t('studio_apps_tables.manager.tab_connectors', 'Connectors'), Icon: Plug },
        { id: 'people', label: t('studio_apps_tables.manager.tab_people', 'People'), Icon: UserRound },
    ];
    return (
        <div className="mb-3 flex items-center gap-1 border-b border-[var(--border-default)]">
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    onClick={() => onTab(tab.id)}
                    disabled={tab.disabled}
                    title={tab.disabled ? tab.title : undefined}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm -mb-px border-b-2 ${tab.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                    style={{
                        borderColor: activeTab === tab.id ? 'var(--accent-primary)' : 'transparent',
                        color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-tertiary)',
                        fontWeight: activeTab === tab.id ? 600 : 400,
                    }}
                    aria-current={activeTab === tab.id ? 'page' : undefined}
                >
                    <tab.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {tab.label}
                </button>
            ))}
            {selectedSource ? (
                <span className="ml-auto pr-1 text-xs text-[var(--text-tertiary)]">
                    {t('app_studio.tables.rows_linked_hint', 'Rows come from a Studio table.')}
                </span>
            ) : selected && !selectedSaved ? (
                <span className="ml-auto pr-1 text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_tables.manager.rows_unsaved_hint', 'Save the table to start adding rows.')}
                </span>
            ) : null}
        </div>
    );
}

/** Whether this app may read the organisation's member list. */
export function PeopleTab({ orgMembers, onChange, disabled }: { orgMembers: boolean; onChange: (on: boolean) => void; disabled: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3 py-4 max-w-xl">
            <label className="flex items-start gap-3">
                <input
                    type="checkbox"
                    checked={orgMembers}
                    onChange={(e) => onChange(e.target.checked)}
                    disabled={disabled}
                    className="mt-0.5 accent-[var(--accent-primary)]"
                />
                <span>
                    <span className="block text-sm text-[var(--text-primary)]">
                        {t('studio_apps_tables.manager.people_label', 'Let this app see who is in your organisation')}
                    </span>
                    <span className="block text-xs mt-0.5 text-[var(--text-tertiary)]">
                        {t('studio_apps_tables.manager.people_desc', 'Person fields can then offer your real colleagues, and work assigned to someone is assigned to their account — so “only mine” means them, not a name that happens to match. Anyone who can open this app sees the list.')}
                    </span>
                </span>
            </label>
            <p className="text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_tables.manager.people_note', 'Only names are shared — never e-mail addresses, and never anyone outside your organisation.')}
            </p>
        </div>
    );
}

interface TableListProps {
    tables: ModelTable[];
    selectedId: string | null;
    savedIds: Set<string>;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
    onAdd: () => void;
}

/** One table in the list, with its kind's icon, badge and delete button. */
function TableListRow({ tbl, selected, isSaved, onSelect, onDelete }: { tbl: ModelTable; selected: boolean; isSaved: boolean; onSelect: () => void; onDelete: () => void }) {
    const { t } = useTranslation();
    // The kind decides the icon, the label and — for a linked table — the
    // row's accessible name. A table with its own storage keeps exactly the
    // name it had: that is the existing kind, and it keeps working.
    const src = tableSourceOf(tbl);
    const SourceIcon = src ? Link2 : Table2;
    const name = tbl.name || tbl.key;
    return (
        <div className="group flex items-center gap-1">
            <button
                type="button"
                onClick={onSelect}
                aria-label={src
                    ? t('app_studio.tables.source_row_label', '{name} — linked to a Studio table', { name })
                    : undefined}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                style={{
                    background: selected ? 'var(--bg-tertiary)' : 'transparent',
                    color: 'var(--text-primary)',
                }}
            >
                <SourceIcon
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: src ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
                    aria-hidden="true"
                />
                <span className="truncate">{name}</span>
                {src ? (
                    <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]">
                        {t('app_studio.tables.source_badge_linked', 'Linked')}
                    </span>
                ) : !isSaved ? (
                    <span className="ml-auto text-[9px] uppercase tracking-wide text-[var(--accent-primary)]">{t('studio_apps_tables.manager.new_badge', 'New')}</span>
                ) : null}
            </button>
            <button
                type="button"
                aria-label={t('studio_apps_tables.manager.delete_named', 'Delete {name}', { name })}
                onClick={onDelete}
                // Always visible. A destructive action hidden behind hover is
                // unreachable by keyboard and by touch, and it is only ever
                // FOUND by hovering something you were not trying to delete.
                // Muted until hover instead — discoverable, not shouty.
                className="p-1 rounded opacity-60 hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--bg-card-hover)] transition-opacity text-[var(--error)]"
            >
                <Trash2 className="h-3.5 w-3.5" />
            </button>
        </div>
    );
}

/** The app's tables, left of the designer. */
export function TableList({ tables, selectedId, savedIds, onSelect, onDelete, onAdd }: TableListProps) {
    const { t } = useTranslation();
    return (
        <div className="w-56 shrink-0 border-r pr-3 flex flex-col gap-1 border-[var(--border-default)]">
            {tables.length === 0 ? (
                <p className="px-1 py-2 text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_tables.manager.no_tables', 'No tables yet. Add one to store records.')}
                </p>
            ) : tables.map((tbl) => (
                <TableListRow key={tbl.id} tbl={tbl} selected={tbl.id === selectedId} isSaved={savedIds.has(tbl.id)}
                    onSelect={() => onSelect(tbl.id)} onDelete={() => onDelete(tbl.id)} />
            ))}
            <button
                type="button"
                onClick={onAdd}
                className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs border-[var(--border-default)] text-[var(--text-secondary)]"
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('studio_apps_tables.manager.new_table', 'New table')}
            </button>
        </div>
    );
}
