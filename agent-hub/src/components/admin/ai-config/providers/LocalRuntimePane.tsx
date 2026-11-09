// The detail of one connected self-hosted runtime: its address, a connection
// test, the model download (Ollama) and the models it serves.

import PaneHeader from './PaneHeader';
import ProviderModels from './ProviderModels';
import type { ProviderPaneProps } from './types';
import type { ModelRow } from './useAiProviderModels';
import RuntimeRow from '../ProviderCards/local/RuntimeRow';
import type { RuntimeInfo, RuntimeProvider, StarterModel } from '@/api/runtimeTypes';
import { useTranslation } from '@/hooks/useTranslation';

interface LocalRuntimePaneProps extends ProviderPaneProps {
    provider: RuntimeProvider;
    runtime: RuntimeInfo;
    starterModels: StarterModel[];
    allModels: ModelRow[];
    loadingModels?: boolean;
    onChanged: () => void;
    onRemove: (id: string) => void;
}

export default function LocalRuntimePane({ provider, runtime, starterModels, allModels, loadingModels, onMessage, onChanged, onRemove }: LocalRuntimePaneProps) {
    const { t } = useTranslation();
    const models = allModels.filter(m => m.providerId === provider.id);
    return (
        <div className="flex flex-col gap-4">
            <PaneHeader
                icon="🖥️"
                iconClass="[background:linear-gradient(135deg,rgba(34,197,94,0.2),rgba(16,185,129,0.2))]"
                title={provider.name || provider.id}
                connected
                statusLabel={t('admin_ai_config.local_status', 'Self-hosted')}
                description={t('admin_ai_config.local_pane_desc', 'Runs on your own hardware: nothing leaves your infrastructure, and there is no per-token cost.')}
            />
            <RuntimeRow
                provider={provider}
                runtime={runtime}
                starterModels={starterModels}
                onMessage={onMessage}
                onChanged={onChanged}
                onRemove={onRemove}
            />
            <ProviderModels models={models} loading={loadingModels} />
        </div>
    );
}
