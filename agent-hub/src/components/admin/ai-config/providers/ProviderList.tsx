// The left column of the providers section, grouped by state: Connected (a key
// is stored), Available (no key yet) and Local (self-hosted runtimes). Below the
// groups the reranker and a dashed button to connect another runtime.

import { Plus } from 'lucide-react';
import type { ProviderEntry } from './providerRegistry';
import { ADD_LOCAL_ID, RERANKER_ID, localPaneId } from './providerRegistry';
import { DetailListGroup as Group, DetailListNav, DetailListRow as Row } from '@/components/shared/DetailList';
import type { RuntimeProvider } from '@/api/runtimeTypes';
import { useTranslation } from '@/hooks/useTranslation';

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
        <DetailListNav label={t('admin_ai_config.providers_nav', 'Providers')}>
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
        </DetailListNav>
    );
}
