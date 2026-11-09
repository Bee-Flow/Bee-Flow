import type { ModelRow } from './useAiProviderModels';
import Section from '@/components/shared/Section';
import Disclosure from '@/components/shared/Disclosure';
import { CHIP } from '@/components/mcpLibrary/ui';
import { getModelMeta } from '@/api/modelMeta';
import { useTranslation } from '@/hooks/useTranslation';

interface ProviderModelsProps {
    models: ModelRow[];
    loading?: boolean;
}

/** The models a provider offers, open by default. */
export default function ProviderModels({ models, loading }: ProviderModelsProps) {
    const { t } = useTranslation();
    const title = models.length === 1
        ? t('admin_ai_config.index_models_one', '1 available model')
        : t('admin_ai_config.index_models_other', '{count} available models', { count: models.length });
    return (
        <Section>
                <Disclosure title={title} defaultOpen>
                    {models.length === 0 ? (
                        <p className="text-xs text-[var(--text-tertiary)]">
                            {loading
                                ? t('admin_ai_config.index_loading_models', 'Loading available models...')
                                : t('admin_ai_config.models_none', 'No models yet. Connect this provider to see what it offers.')}
                        </p>
                    ) : (
                        <ul className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 md:grid-cols-2">
                            {models.map(model => {
                                const meta = getModelMeta(model.id);
                                return (
                                    <li key={model.id} className="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs">
                                        <span className="flex-1 truncate font-medium text-[var(--text-primary)]">
                                            {meta?.name || model.name || model.id}
                                        </span>
                                        {meta?.cat && <span className={CHIP}>{meta.cat}</span>}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Disclosure>
        </Section>
    );
}
