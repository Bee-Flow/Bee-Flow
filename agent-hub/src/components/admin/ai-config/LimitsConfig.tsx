// The Limits page of AI configuration: what this server runs with right now,
// read from the STORED configuration (an unsaved edit elsewhere never shows
// here), each row a jump to the page that sets it. The settings themselves
// live on those pages: the tool-round cap on Direct chat, the knowledge-base
// provider, the CPU reranker, the embedding model and the web search provider
// on Search & retrieval.
import React from 'react';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

interface LimitsConfigProps {
    /** Go to another section of AI configuration (its URL id). */
    onNavigateToTab?: (section: string) => void;
}

/** The keys of GET /ai/config this page reads. */
interface LimitsConfigData {
    maxToolRoundsChat?: number | string | null;
    toolRoundDefaults?: Partial<Record<string, number>>;
    kbProvider?: string | null;
    cpuRerankerEnabled?: boolean;
    embeddingModel?: string | null;
    embeddingProviderId?: string | null;
    searchProvider?: string | null;
    hasSerperKey?: boolean;
    hasAgentSearchUrl?: boolean;
    hasBingSearchKey?: boolean;
}

type StatusRowProps = { label: string; value: React.ReactNode; onClick?: () => void };

function StatusRow({ label, value, onClick }: StatusRowProps) {
    return (
        <SettingRow label={label}>
            {onClick
                ? <button type="button" onClick={onClick} className="w-full rounded-md px-2 py-1 text-left text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] md:text-right">{value}</button>
                : <div className="px-2 text-[13px] font-medium text-[var(--text-primary)] md:text-right">{value}</div>}
        </SettingRow>
    );
}

const WARN = 'text-[var(--warning-ink)]';

function searchLabel(t: TranslateFn, provider: string): string {
    if (provider === 'node-search') return t('admin_ai_config.limits_search_cloud', 'Cloud-only (Serper + provider APIs)');
    if (provider === 'bing') return t('admin_ai_config.limits_search_bing', 'Azure Bing Web Search');
    if (provider === 'disabled') return t('admin_ai_config.disabled', 'Disabled');
    return t('admin_ai_config.limits_search_self', 'Self-hosted (Agent Search + Serper)');
}

function SearchValue({ t, stored }: { t: TranslateFn; stored: LimitsConfigData }) {
    const provider = stored.searchProvider || 'agent-search';
    return (
        <>
            {searchLabel(t, provider)}
            {(provider === 'node-search' && !stored.hasSerperKey) && <span className={`ml-2 ${WARN}`}>{t('admin_ai_config.limits_needs_serper', '· needs Serper key')}</span>}
            {(provider === 'agent-search' && !stored.hasAgentSearchUrl) && <span className={`ml-2 ${WARN}`}>{t('admin_ai_config.limits_needs_search_url', '· needs SEARCH_SERVICE_URL')}</span>}
            {(provider === 'bing' && !stored.hasBingSearchKey) && <span className={`ml-2 ${WARN}`}>{t('ai_model_setup.limits_needs_bing', '· needs a Bing key')}</span>}
        </>
    );
}

function kbLabel(t: TranslateFn, kbProvider: string | null | undefined): string {
    if (kbProvider === 'local') return t('admin_ai_config.limits_kb_local', 'Local (in-process)');
    if (kbProvider === 'remote') return t('admin_ai_config.limits_kb_remote', 'Remote search-service');
    return t('admin_ai_config.limits_kb_auto', 'Auto');
}

function roundsLabel(t: TranslateFn, stored: LimitsConfigData): string {
    const cap = parseInt(String(stored.maxToolRoundsChat ?? ''), 10);
    if (Number.isInteger(cap) && cap > 0) return t('ai_model_setup.limits_rounds_cap', '{n} rounds on every surface', { n: cap });
    const direct = stored.toolRoundDefaults?.directChat;
    return typeof direct === 'number'
        ? t('ai_model_setup.limits_rounds_default_n', 'Per-surface defaults ({n} in direct chat)', { n: direct })
        : t('admin_ai_config.limits_rounds_placeholder', 'Use per-surface defaults');
}

/** What this server will use right now, from the stored configuration; a row jumps to the page that sets it. */
function LimitsStatus({ t, stored, go }: { t: TranslateFn; stored: LimitsConfigData; go: (section: string) => void }) {
    return (
        <SettingsGroup
            title={t('admin_ai_config.limits_status_title', 'Setup status')}
            description={t('ai_model_setup.limits_status_hint', 'What this server uses right now, as stored. Click a row to go to the page that sets it.')}
        >
            <SettingsList>
                <StatusRow
                    label={t('admin_ai_config.limits_embed_model', 'Embedding model (global)')}
                    onClick={() => go('retrieval')}
                    value={stored.embeddingModel
                        ? `${stored.embeddingModel}${stored.embeddingProviderId ? ` · ${stored.embeddingProviderId}` : ''}`
                        : <span className={WARN}>{t('ai_model_setup.limits_embed_not_set', 'Not set: pick one under Search & retrieval')}</span>}
                />
                <StatusRow label={t('admin_ai_config.limits_search_provider', 'Web search provider')} onClick={() => go('retrieval')} value={<SearchValue t={t} stored={stored} />} />
                <StatusRow label={t('admin_ai_config.limits_kb_provider', 'KB provider')} onClick={() => go('retrieval')} value={kbLabel(t, stored.kbProvider)} />
                <StatusRow
                    label={t('admin_ai_config.limits_cpu_reranker', 'CPU cross-encoder reranker')}
                    onClick={() => go('retrieval')}
                    value={stored.cpuRerankerEnabled !== false ? t('admin_ai_config.enabled', 'Enabled') : t('admin_ai_config.disabled', 'Disabled')}
                />
                <StatusRow label={t('admin_ai_config.limits_rounds_title', 'Tool calls per chat turn')} onClick={() => go('direct-chat')} value={roundsLabel(t, stored)} />
            </SettingsList>
        </SettingsGroup>
    );
}

const LimitsConfig = ({ onNavigateToTab }: LimitsConfigProps) => {
    const { t } = useTranslation();
    const aiConfig = useAiConfigQuery<LimitsConfigData>();
    if (aiConfig.isPending) return <div className="p-4 text-sm text-[var(--text-tertiary)]">{t('admin_ai_config.loading_ellipsis', 'Loading…')}</div>;
    return <LimitsStatus t={t} stored={aiConfig.data?.config ?? {}} go={(section) => onNavigateToTab?.(section)} />;
};

export default LimitsConfig;
