import { AlertTriangle, AppWindow, Database, Plug, Plus, Trash2, Workflow } from 'lucide-react';
import { connectorProblem, labelForKind } from './connectorModel';
import type { Connector, ConnectorGroup, IntegrationCatalog } from './connectorModel';
import { getIntegrationIcon } from '../../../../../../config/integrationIcons';
import useTranslation from '../../../../../../hooks/useTranslation';

interface ConnectorRowProps {
    c: Connector;
    active: boolean;
    catalog: IntegrationCatalog;
    disabled?: boolean;
    onSelect: () => void;
    onRemove: () => void;
}

function ConnectorRow({ c, active, catalog, disabled, onSelect, onRemove }: ConnectorRowProps) {
    const { t } = useTranslation();
    return (
        <div className="group flex items-center gap-1">
            <button
                type="button"
                onClick={onSelect}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                style={{ background: active ? 'var(--bg-tertiary)' : 'transparent', color: 'var(--text-primary)' }}
            >
                <Plug className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                <span className="truncate">{c.name || c.id}</span>
                {connectorProblem(c, catalog.lookup(c.tool)?.action || null, t) ? (
                    <AlertTriangle className="ml-auto h-3 w-3 shrink-0" style={{ color: '#d97706' }} aria-label={t('studio_apps_bi.connectors.not_finished', 'Not finished yet')} />
                ) : c.sync ? (
                    <Database className="ml-auto h-3 w-3 shrink-0 text-[var(--accent-primary)]" aria-label={t('studio_apps_bi.connectors.fills_table', 'Fills a table')} />
                ) : (
                    <span className="ml-auto text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]">{labelForKind(c.kind, t)}</span>
                )}
            </button>
            <button
                type="button"
                aria-label={t('studio_apps_bi.connectors.delete', 'Delete {name}', { name: c.name || c.id })}
                onClick={onRemove}
                disabled={disabled}
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

interface ConnectorListProps {
    list: Connector[];
    grouped: ConnectorGroup[];
    selectedId: string | null;
    adding: boolean;
    choosing: boolean;
    catalog: IntegrationCatalog;
    disabled?: boolean;
    onSelect: (id: string) => void;
    onRemove: (id: string) => void;
    onPick: () => void;
    onAdd: () => void;
}

/** The connector list, grouped by app, with the two ways to add one. */
export default function ConnectorList({ list, grouped, selectedId, adding, choosing, catalog, disabled, onSelect, onRemove, onPick, onAdd }: ConnectorListProps) {
    const { t } = useTranslation();
    return (
        <div className="w-60 shrink-0 border-r pr-3 flex flex-col gap-1 overflow-y-auto max-h-[26rem] border-[var(--border-default)]">
            {list.length === 0 ? (
                <p className="px-1 py-2 text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_bi.connectors.none_yet', 'No connectors yet. Pick the apps and actions this app should pull data from.')}
                </p>
            ) : grouped.map((group) => (
                <div key={group.appId} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 px-1 pt-1.5">
                        <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                            {group.appId !== 'other' ? getIntegrationIcon(group.appId) : <Workflow className="h-3 w-3 text-[var(--text-tertiary)]" />}
                        </div>
                        <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                            {group.label}
                        </span>
                        <span className="ml-auto text-[10px] text-[var(--text-secondary)]">{group.items.length}</span>
                    </div>
                    {group.items.map((c) => (
                        <ConnectorRow key={c.id} c={c} active={c.id === selectedId && !adding} catalog={catalog} disabled={disabled}
                            onSelect={() => onSelect(c.id)} onRemove={() => onRemove(c.id)} />
                    ))}
                </div>
            ))}
            {/* While the kind question is on screen it already offers both
                routes, so the sidebar doesn't repeat them. */}
            {choosing ? null : (
                <>
                    <button
                        type="button"
                        onClick={onPick}
                        disabled={disabled}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-white bg-[var(--accent-primary)]"
                    >
                        <AppWindow className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('studio_apps_bi.connectors.choose_apps', 'Choose apps & actions')}
                    </button>
                    <button
                        type="button"
                        onClick={onAdd}
                        disabled={disabled}
                        className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('studio_apps_bi.connectors.automation_or_web', 'Automation or web address')}
                    </button>
                </>
            )}
        </div>
    );
}
