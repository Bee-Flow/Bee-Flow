// The left column of the providers section, grouped by state: Connected (a key
// is stored), Available (no key yet) and Local (self-hosted runtimes). Below the
// groups the reranker and a dashed button to connect another runtime.

import { Plus } from 'lucide-react';
import type { ProviderEntry } from './providerRegistry';
import { ADD_LOCAL_ID, RERANKER_ID, localPaneId } from './providerRegistry';
import { DOT_LIVE, DOT_OFF, EYEBROW } from '@/components/mcpLibrary/ui';
import type { RuntimeProvider } from '@/api/runtimeTypes';
import { useTranslation } from '@/hooks/useTranslation';

interface RowProps {
    icon: string;
    iconClass?: string;
    name: string;
    live: boolean;
    meta?: string;
    active: boolean;
    onClick: () => void;
}

function Row({ icon, iconClass = '', name, live, meta, active, onClick }: RowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'true' : undefined}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text-primary)] ${active ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-secondary)]'}`}
        >
            <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs ${iconClass}`}>{icon}</span>
            <span className="truncate">{name}</span>
            {meta ? <span className="ml-auto shrink-0 text-[11px] text-[var(--text-tertiary)]">{meta}</span> : null}
            <span className={`${live ? DOT_LIVE : DOT_OFF} ${meta ? '' : 'ml-auto'}`} aria-hidden="true" />
        </button>
    );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-0.5" aria-label={title}>
            <div className="flex items-center gap-1.5 px-1 pt-2">
                <h3 className={EYEBROW}>{title}</h3>
                <span className="ml-auto text-[10px] text-[var(--text-secondary)]">{count}</span>
            </div>
            {children}
        </section>
    );
}

interface ProviderListProps {
    entries: ProviderEntry[];
    connectedIds: ReadonlySet<string>;
    /** Number of models per provider id; shown on connected providers. */
    modelCounts: Readonly<Record<string, number>>;
    localProviders: RuntimeProvider[];
    rerankerConnected: boolean;
    selectedId: string | null;
    onSelect: (id: string) => void;
}

export default function ProviderList({ entries, connectedIds, modelCounts, localProviders, rerankerConnected, selectedId, onSelect }: ProviderListProps) {
    const { t } = useTranslation();
    const connected = entries.filter(e => connectedIds.has(e.id));
    const available = entries.filter(e => !connectedIds.has(e.id));
    const renderEntry = (e: ProviderEntry, live: boolean) => {
        const count = modelCounts[e.id] ?? 0;
        return (
            <Row
                key={e.id}
                icon={e.icon}
                iconClass={e.iconClass}
                name={e.name}
                live={live}
                meta={live && count > 0 ? String(count) : undefined}
                active={selectedId === e.id}
                onClick={() => onSelect(e.id)}
            />
        );
    };
    return (
        <nav aria-label={t('admin_ai_config.providers_nav', 'Providers')} className="flex w-full shrink-0 flex-col gap-1 overflow-y-auto border-b border-[var(--border-default)] pb-3 md:w-60 md:border-b-0 md:border-r md:pb-0 md:pr-3">
            {connected.length > 0 && (
                <Group title={t('admin_ai_config.group_connected', 'Connected')} count={connected.length}>
                    {connected.map(e => renderEntry(e, true))}
                </Group>
            )}
            {available.length > 0 && (
                <Group title={t('admin_ai_config.group_available', 'Available')} count={available.length}>
                    {available.map(e => renderEntry(e, false))}
                </Group>
            )}
            {localProviders.length > 0 && (
                <Group title={t('admin_ai_config.group_local', 'Local')} count={localProviders.length}>
                    {localProviders.map(p => (
                        <Row
                            key={p.id}
                            icon="🖥️"
                            name={p.name || p.id}
                            live
                            meta={modelCounts[localPaneId(p.id)] ? String(modelCounts[localPaneId(p.id)]) : undefined}
                            active={selectedId === localPaneId(p.id)}
                            onClick={() => onSelect(localPaneId(p.id))}
                        />
                    ))}
                </Group>
            )}
            <div className="mt-2 flex flex-col gap-1 border-t border-[var(--border-default)] pt-2">
                <Row
                    icon="🎯"
                    name={t('admin_ai_config.reranker_row', 'Reranker')}
                    live={rerankerConnected}
                    active={selectedId === RERANKER_ID}
                    onClick={() => onSelect(RERANKER_ID)}
                />
                <button
                    type="button"
                    onClick={() => onSelect(ADD_LOCAL_ID)}
                    aria-current={selectedId === ADD_LOCAL_ID ? 'true' : undefined}
                    className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border-default)] px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('admin_ai_config.add_local_runtime', 'Add local runtime')}
                </button>
            </div>
        </nav>
    );
}
