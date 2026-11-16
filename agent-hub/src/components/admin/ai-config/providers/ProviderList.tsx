// The left column of the providers section, grouped by what a provider serves:
// Language models (chat, embeddings, rerank), Speech & media (voice and sound
// only) and Self-hosted (the runtimes connected on this server). Within a group
// the connected providers come first; a live dot says which. Below the groups a
// dashed button connects another runtime. Reranking is set up under Search &
// retrieval, not here.

import { Plus } from 'lucide-react';
import type { ProviderEntry, ProviderGroup } from './providerRegistry';
import { ADD_LOCAL_ID, localPaneId } from './providerRegistry';
import { DetailListGroup as Group, DetailListNav, DetailListRow as Row } from '@/components/shared/DetailList';
import type { RuntimeProvider } from '@/api/runtimeTypes';
import { useTranslation } from '@/hooks/useTranslation';

interface ProviderListProps {
    entries: ProviderEntry[];
    connectedIds: ReadonlySet<string>;
    /** Number of models per provider id; shown on connected providers. */
    modelCounts: Readonly<Record<string, number>>;
    localProviders: RuntimeProvider[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}

/** The entries of one group, connected first, each half in registry order. */
function ofGroup(entries: ProviderEntry[], group: ProviderGroup, connectedIds: ReadonlySet<string>): ProviderEntry[] {
    const own = entries.filter(e => e.group === group);
    return [...own.filter(e => connectedIds.has(e.id)), ...own.filter(e => !connectedIds.has(e.id))];
}

export default function ProviderList({ entries, connectedIds, modelCounts, localProviders, selectedId, onSelect }: ProviderListProps) {
    const { t } = useTranslation();
    const language = ofGroup(entries, 'language', connectedIds);
    const media = ofGroup(entries, 'media', connectedIds);
    const renderEntry = (e: ProviderEntry) => {
        const live = connectedIds.has(e.id);
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
            {language.length > 0 && (
                <Group title={t('ai_model_setup.group_language', 'Language models')} count={language.length}>
                    {language.map(renderEntry)}
                </Group>
            )}
            {media.length > 0 && (
                <Group title={t('ai_model_setup.group_media', 'Speech & media')} count={media.length}>
                    {media.map(renderEntry)}
                </Group>
            )}
            {localProviders.length > 0 && (
                <Group title={t('ai_model_setup.group_self_hosted', 'Self-hosted')} count={localProviders.length}>
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
            <div className="mt-2 flex flex-col gap-1 border-t border-[var(--border-subtle)] pt-2">
                <button
                    type="button"
                    onClick={() => onSelect(ADD_LOCAL_ID)}
                    aria-current={selectedId === ADD_LOCAL_ID ? 'true' : undefined}
                    className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--border-default)] px-2 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]"
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('admin_ai_config.add_local_runtime', 'Add local runtime')}
                </button>
            </div>
        </DetailListNav>
    );
}
