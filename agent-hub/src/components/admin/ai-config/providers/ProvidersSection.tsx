// The providers section: a list of providers on the left, the detail of the
// selected one on the right (the App Studio connectors layout). The selection
// lives in the URL (admin/ai-config/providers/<id>), so a deep link and the Back
// button work; with none in the URL the first connected provider is shown, and
// when nothing is connected yet a picker asks which one to connect first.

import { useMemo } from 'react';
import AddRuntimePane from './AddRuntimePane';
import LocalRuntimePane from './LocalRuntimePane';
import PaneHeader from './PaneHeader';
import ProviderDetail from './ProviderDetail';
import ProviderList from './ProviderList';
import { ADD_LOCAL_ID, PROVIDER_REGISTRY, RERANKER_ID, findProvider, localPaneId, rerankerConnected, resolveSelection } from './providerRegistry';
import type { ProviderPaneProps } from './types';
import { useLocalRuntimes } from './useLocalRuntimes';
import { useSelectNewRuntime } from './useSelectNewRuntime';
import type { ModelRow, ProviderRow } from './useAiProviderModels';
import RerankerConfig from '../RerankerConfig';
import { CARD_BUTTON } from '@/components/mcpLibrary/ui';
import { DetailLayout } from '@/components/shared/DetailList';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import { disconnectRuntime } from '@/api/localRuntimeApi';
import { useTranslation } from '@/hooks/useTranslation';

interface ProvidersSectionProps extends ProviderPaneProps {
    /** The provider pane id from the URL, if any. */
    selectedId?: string;
    onSelect: (id: string) => void;
    /** The providers GET /ai/providers lists (the reranker can use one of them). */
    providers: ProviderRow[];
    allModels: ModelRow[];
    loadingModels: boolean;
    /** Read the provider list and the models again. */
    onProvidersChanged: () => void;
}

interface RerankerPaneProps extends ProviderPaneProps {
    connected: boolean;
    providers: ProviderRow[];
    allModels: ModelRow[];
}

function RerankerPane({ connected, providers, allModels, onMessage }: RerankerPaneProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-4">
            <PaneHeader
                icon="🎯"
                iconClass="[background:linear-gradient(135deg,rgba(234,88,12,0.2),rgba(249,115,22,0.2))]"
                title={t('admin_ai_config.reranker_row', 'Reranker')}
                connected={connected}
            />
            <RerankerConfig onMessage={onMessage} providers={providers} allModels={allModels} />
        </div>
    );
}

/** Nothing connected yet and nothing chosen: ask which provider to connect first. */
function ProviderPicker({ onSelect }: { onSelect: (id: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3">
            <div>
                <p className="m-0 text-sm font-medium text-[var(--text-primary)]">{t('admin_ai_config.pick_title', 'Pick a provider to connect')}</p>
                <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('admin_ai_config.pick_hint', 'Add an API key and its models become available under Chat Models.')}</p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {PROVIDER_REGISTRY.map(e => (
                    <button key={e.id} type="button" onClick={() => onSelect(e.id)} className={CARD_BUTTON}>
                        <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                            <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded text-sm ${e.iconClass}`}>{e.icon}</span>
                            {e.name}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

export default function ProvidersSection({ selectedId: urlId, onSelect, providers, allModels, loadingModels, onProvidersChanged, onMessage }: ProvidersSectionProps) {
    const { t } = useTranslation();
    const config = useAiConfigQuery().data?.config ?? null;
    const local = useLocalRuntimes();

    const connectedIds = useMemo(
        () => new Set(PROVIDER_REGISTRY.filter(e => e.isConnected(config)).map(e => e.id)),
        [config],
    );
    const modelCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const e of PROVIDER_REGISTRY) counts[e.id] = allModels.filter(m => m.providerName === e.name).length;
        for (const p of local.localProviders) counts[localPaneId(p.id)] = allModels.filter(m => m.providerId === p.id).length;
        return counts;
    }, [allModels, local.localProviders]);

    const { selectedId, localProvider } = resolveSelection(urlId, local.localProviders, connectedIds);

    const watchForNewRuntime = useSelectNewRuntime(local.localProviders, onSelect);
    const changed = () => {
        void local.reload();
        onProvidersChanged();
    };

    const handleRemove = async (id: string) => {
        const { ok } = await disconnectRuntime(id);
        onMessage?.(ok
            ? { type: 'success', text: t('admin_ai_config.local_disconnected', 'Runtime disconnected') }
            : { type: 'error', text: t('admin_ai_config.local_disconnect_failed', 'Failed to disconnect the runtime') });
        if (ok) changed();
    };

    let detail: React.ReactNode;
    const entry = findProvider(selectedId);
    if (entry) {
        detail = <ProviderDetail entry={entry} config={config} allModels={allModels} loadingModels={loadingModels} onMessage={onMessage} />;
    } else if (selectedId === RERANKER_ID) {
        detail = <RerankerPane connected={rerankerConnected(config)} providers={providers} allModels={allModels} onMessage={onMessage} />;
    } else if (selectedId === ADD_LOCAL_ID) {
        detail = <AddRuntimePane runtimes={local.runtimes} unsupported={local.unsupported} connectedCount={local.localProviders.length} onMessage={onMessage} onChanged={() => { watchForNewRuntime(); changed(); }} />;
    } else if (localProvider) {
        detail = (
            <LocalRuntimePane
                provider={localProvider}
                runtime={local.runtimes.find(r => r.type === localProvider.type) || {}}
                starterModels={local.starterModels}
                allModels={allModels}
                loadingModels={loadingModels}
                onMessage={onMessage}
                onChanged={changed}
                onRemove={handleRemove}
            />
        );
    } else {
        detail = <ProviderPicker onSelect={onSelect} />;
    }

    return (
        <DetailLayout
            list={(<ProviderList
                entries={PROVIDER_REGISTRY}
                connectedIds={connectedIds}
                modelCounts={modelCounts}
                localProviders={local.localProviders}
                rerankerConnected={rerankerConnected(config)}
                selectedId={selectedId}
                onSelect={onSelect}
            />)}
        >
            {detail}
        </DetailLayout>
    );
}
