// The two retrieval switches that sat under Limits: where knowledge-base search
// runs (in this server or on the search service), and the CPU fallback of the
// rerank chain. A choice and a switch, so each saves when it is made, with a
// SaveStatus next to it.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiConfigKey, useAiConfigQuery } from '@/api/queries/aiConfigRead';
import { ApiError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import ChoiceCards from '@/components/shared/ChoiceCards';
import SaveStatus from '@/components/shared/SaveStatus';
import { SettingBlock, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { useTranslation } from '@/hooks/useTranslation';

type KbProvider = 'auto' | 'local' | 'remote';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface KnowledgeSearchRead {
    kbProvider?: string | null;
    cpuRerankerEnabled?: boolean;
}

const asKbProvider = (value: string | null | undefined): KbProvider => (value === 'local' || value === 'remote' ? value : 'auto');

/**
 * One setting of POST /ai/config that saves as soon as it changes: the value to
 * show (the pick until the stored answer has it), and the save state.
 */
function useAutosavedSetting<T>(stored: T, toBody: (value: T) => Record<string, unknown>) {
    const queryClient = useQueryClient();
    const [pending, setPending] = useState<{ value: T } | null>(null);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [last, setLast] = useState<{ value: T } | null>(null);

    const save = async (value: T) => {
        setPending({ value });
        setLast({ value });
        setSaveState('saving');
        try {
            await apiRequest('POST /ai/config', { body: toBody(value) });
            await queryClient.invalidateQueries({ queryKey: aiConfigKey });
            setSaveState('saved');
            setLastSavedAt(new Date());
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            setSaveState('error');
        }
        setPending(null);
    };

    return {
        value: pending ? pending.value : stored,
        save,
        saving: saveState === 'saving',
        status: { saveState, lastSavedAt, onRetry: last ? () => { void save(last.value); } : null },
    };
}

/** Where knowledge-base chunks are found and ranked: a group of its own on Search & retrieval. */
export function KbProviderGroup() {
    const { t } = useTranslation();
    const aiConfig = useAiConfigQuery<KnowledgeSearchRead>();
    const setting = useAutosavedSetting<KbProvider>(
        asKbProvider(aiConfig.data?.config?.kbProvider),
        (value) => ({ kbProvider: value === 'auto' ? null : value }),
    );
    const options = [
        { value: 'auto' as const, label: t('admin_ai_config.limits_kb_auto', 'Auto'), description: t('admin_ai_config.limits_kb_auto_desc', 'Local KB when no SEARCH_SERVICE_URL is set, remote service when it is. Safe default for both fresh installs and upgrades.') },
        { value: 'local' as const, label: t('admin_ai_config.limits_kb_local', 'Local (in-process)'), description: t('admin_ai_config.limits_kb_local_desc', 'pgvector + RRF + reranker run inside this Node server. No GPU service required. Recommended for most self-hosted setups.') },
        { value: 'remote' as const, label: t('admin_ai_config.limits_kb_remote', 'Remote search-service'), description: t('ai_model_setup.kb_remote_desc', 'Forward knowledge-base ingest and search to an external search service (SEARCH_SERVICE_URL). Required for GPU-backed deployments.') },
    ];
    return (
        <SettingsGroup
            title={t('ai_model_setup.kb_search_title', 'Knowledge-base search')}
            description={t('ai_model_setup.kb_search_hint', 'Where knowledge-base chunks are found and ranked. Applies immediately.')}
            actions={<SaveStatus {...setting.status} size={12} />}
        >
            <SettingsList>
                <SettingBlock
                    label={t('admin_ai_config.limits_kbp_title', 'Knowledge-base provider')}
                    hint={t('admin_ai_config.limits_kbp_hint', 'Where KB chunk retrieval and ranking happens. Local routes everything through the in-process pgvector + reranker pipeline; remote forwards to the external search-service.')}
                >
                    <ChoiceCards
                        value={setting.value}
                        onChange={(next) => { if (next !== setting.value) void setting.save(next); }}
                        options={options}
                        ariaLabel={t('admin_ai_config.limits_kbp_title', 'Knowledge-base provider')}
                        disabled={setting.saving || aiConfig.isPending}
                        columns={3}
                    />
                </SettingBlock>
            </SettingsList>
        </SettingsGroup>
    );
}

/** The last tier of the rerank chain, as a row of the Reranking group. */
export function CpuRerankerRow() {
    const { t } = useTranslation();
    const aiConfig = useAiConfigQuery<KnowledgeSearchRead>();
    const setting = useAutosavedSetting<boolean>(aiConfig.data?.config?.cpuRerankerEnabled !== false, (value) => ({ cpuRerankerEnabled: value }));
    return (
        <SettingRow
            label={t('admin_ai_config.limits_cpu_title', 'In-process CPU reranker')}
            hint={t('admin_ai_config.limits_cpu_hint', 'Used when no earlier reranker in the chain answers: a cross-encoder (bge-reranker-base, MIT, ~280 MB) that runs on this server\'s CPU. The first call downloads the model; after that it runs locally with no network round-trip.')}
        >
            <div className="flex items-center justify-end gap-3">
                <SaveStatus {...setting.status} size={12} />
                <Toggle
                    checked={setting.value}
                    onChange={(next) => { void setting.save(next); }}
                    disabled={setting.saving || aiConfig.isPending}
                    ariaLabel={t('admin_ai_config.limits_cpu_enable', 'Enable CPU cross-encoder reranker (recommended)')}
                />
            </div>
        </SettingRow>
    );
}
