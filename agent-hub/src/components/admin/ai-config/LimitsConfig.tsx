import React, { useMemo, useState } from 'react';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, Field, OptionCard, SAVE_BUTTON, SettingBlock, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useToastOnMessage } from './ui/useToastOnMessage';
import Toggle from '@/components/shared/Toggle';
import useDraftOverServer from '@/hooks/useDraftOverServer';
import { API_BASE } from '@/utils/helpers';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { StatusMessage } from './chatModelTiers/tierTypes';
import { mutate, ApiError } from '@/api/mutate';

interface LimitsConfigProps {
    onNavigateToTab?: (tab: string) => void;
}

/** The keys of GET /ai/config this card reads. */
interface LimitsConfigData {
    maxToolRoundsChat?: number | string | null;
    kbProvider?: string | null;
    cpuRerankerEnabled?: boolean;
    embeddingModel?: string | null;
    embeddingProviderId?: string | null;
    searchProvider?: string | null;
    hasSerperKey?: boolean;
    hasAgentSearchUrl?: boolean;
}

interface LimitsStatus {
    embedModel: string | null;
    embedProvider: string | null;
    searchProvider: string | null;
    hasSerperKey: boolean;
    hasAgentSearchUrl: boolean;
}

const LimitsConfig = ({ onNavigateToTab }: LimitsConfigProps) => {
    const { t } = useTranslation();
    const PER_SURFACE_DEFAULTS = [
        { name: t('admin_ai_config.limits_surface_direct', 'Direct chat'), value: 5 },
        { name: t('admin_ai_config.limits_surface_notebook', 'Notebook chat'), value: 5 },
        { name: t('admin_ai_config.limits_surface_webpage', 'Webpage chat'), value: 10 },
        { name: t('admin_ai_config.limits_surface_native', 'Native streaming loop'), value: 10 },
    ];
    const aiConfig = useAiConfigQuery<LimitsConfigData>();
    const stored = aiConfig.data?.config;
    const serverForm = useMemo(() => ({
        value: String(stored?.maxToolRoundsChat ?? ''),
        kbProvider: stored?.kbProvider || 'auto',
        cpuRerankerEnabled: stored?.cpuRerankerEnabled !== false,
    }), [stored]);
    const { value: form, patch, discard } = useDraftOverServer(serverForm);
    const { value, kbProvider, cpuRerankerEnabled } = form;
    const setValue: React.Dispatch<React.SetStateAction<string>> = (next) => patch({ value: typeof next === 'function' ? next(value) : next });
    const setKbProvider = (next: string) => patch({ kbProvider: next });
    const status: LimitsStatus = useMemo(() => ({
        embedModel: stored?.embeddingModel || null,
        embedProvider: stored?.embeddingProviderId || null,
        searchProvider: stored?.searchProvider || 'agent-search',
        hasSerperKey: !!stored?.hasSerperKey,
        hasAgentSearchUrl: !!stored?.hasAgentSearchUrl,
    }), [stored]);
    const loading = aiConfig.isPending;
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);
    const { refetch: fetchConfig } = aiConfig;


    const handleSave = async () => {
        setSaving(true);
        try {
            const trimmed = String(value).trim();
            const payload = {
                maxToolRoundsChat: trimmed === '' ? null : parseInt(trimmed, 10),
                kbProvider: kbProvider === 'auto' ? null : kbProvider,
                cpuRerankerEnabled,
            };
            const res = await mutate(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setMessage({ type: 'success', text: t('admin_ai_config.limits_saved', 'Saved') });
                fetchConfig().then(discard);
            } else {
                setMessage({ type: 'error', text: t('admin_ai_config.limits_save_failed', 'Failed to save') });
            }
        } catch (_) {
            setMessage({ type: 'error', text: t('admin_ai_config.limits_save_failed', 'Failed to save') });
        } finally {
            setSaving(false);
            setTimeout(() => setMessage(null), 2500);
        }
    };

    useToastOnMessage(message);
    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_ai_config.loading_ellipsis', 'Loading…')}</div>;

    const KB_OPTIONS = [
        { id: 'auto', label: t('admin_ai_config.limits_kb_auto', 'Auto'), desc: t('admin_ai_config.limits_kb_auto_desc', 'Local KB when no SEARCH_SERVICE_URL is set, remote service when it is. Safe default for both fresh installs and upgrades.') },
        { id: 'local', label: t('admin_ai_config.limits_kb_local', 'Local (in-process)'), desc: t('admin_ai_config.limits_kb_local_desc', 'pgvector + RRF + reranker run inside this Node server. No GPU service required. Recommended for most self-hosted setups.') },
        { id: 'remote', label: t('admin_ai_config.limits_kb_remote', 'Remote search-service'), desc: t('admin_ai_config.limits_kb_remote_desc', 'Forward KB ingest + search to the external services.beeflow.nl (or self-hosted SEARCH_SERVICE_URL). Required for legacy GPU-backed deployments.') },
    ];

    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SectionHeader
                title={t('admin_ai_config.limits_title', 'Limits & Self-host')}
                description={t('admin_ai_config.limits_subtitle', 'Runtime caps and routing for self-hosted deployments. Background agents (AI tasks, swarms, browser, automation builder) keep their own internal limits and are out of scope.')}
            />

            <LimitsStatus t={t} onNavigateToTab={onNavigateToTab} status={status} kbProvider={kbProvider} cpuRerankerEnabled={cpuRerankerEnabled} />

            <SettingsGroup title={t('admin_ai_config.limits_group', 'Limits')}>
                <SettingsList>
                    <SettingRow
                        htmlFor="limits-rounds"
                        label={t('admin_ai_config.limits_rounds_title', 'Tool calls per chat turn')}
                        hint={t('admin_ai_config.limits_rounds_hint', 'Maximum number of tool-call rounds the model is allowed before it must produce a final answer. Applies uniformly to direct chat, notebook chat, webpage chat, and the native streaming loop.')}
                        expanded={(
                            <Field label={t('admin_ai_config.limits_surface_title', 'Per-surface defaults (when empty)')}>
                                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                                    {PER_SURFACE_DEFAULTS.map((d: { name: string; value: number }) => (
                                        <div key={d.name} className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-xs">
                                            <div className="text-[var(--text-tertiary)]">{d.name}</div>
                                            <div className="mt-0.5 font-semibold text-[var(--text-primary)]">{d.value} {t('admin_ai_config.limits_rounds_unit', 'rounds')}</div>
                                        </div>
                                    ))}
                                </div>
                            </Field>
                        )}
                    >
                        <input
                            id="limits-rounds"
                            type="number"
                            min="1"
                            max="50"
                            value={value}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
                            placeholder={t('admin_ai_config.limits_rounds_placeholder', 'Use per-surface defaults')}
                            title={t('admin_ai_config.limits_rounds_range', 'Range 1 to 50. Leave empty to use per-surface defaults.')}
                            className={FIELD_INPUT} />
                    </SettingRow>

                    <SettingBlock
                        label={t('admin_ai_config.limits_kbp_title', 'Knowledge-base provider')}
                        hint={t('admin_ai_config.limits_kbp_hint', 'Where KB chunk retrieval and ranking happens. Local routes everything through the in-process pgvector + reranker pipeline; remote forwards to the external search-service.')}
                    >
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                            {KB_OPTIONS.map((opt: { id: string; label: string; desc: string }) => (
                                <OptionCard key={opt.id} selected={kbProvider === opt.id} onClick={() => setKbProvider(opt.id)} title={opt.label} description={opt.desc} />
                            ))}
                        </div>
                    </SettingBlock>

                    <SettingRow
                        label={t('admin_ai_config.limits_cpu_title', 'In-process CPU reranker')}
                        hint={t('admin_ai_config.limits_cpu_hint', 'When Azure Cohere reranker is not configured, fall back to the in-process Transformers.js cross-encoder (Xenova/bge-reranker-base, MIT, ~280 MB). First call downloads the model; subsequent calls run locally with no network round-trip.')}
                    >
                        <div className="flex justify-end">
                            <Toggle
                                checked={cpuRerankerEnabled}
                                onChange={(next) => patch({ cpuRerankerEnabled: next })}
                                ariaLabel={t('admin_ai_config.limits_cpu_enable', 'Enable CPU cross-encoder reranker (recommended)')}
                            />
                        </div>
                    </SettingRow>
                </SettingsList>
            </SettingsGroup>

            <div>
                <button type="button" onClick={handleSave} disabled={saving} className={SAVE_BUTTON}>
                    {saving ? t('admin_ai_config.saving_ellipsis', 'Saving…') : t('admin_ai_config.save', 'Save')}
                </button>
            </div>
        </div>
    );
};

export default LimitsConfig;

type StatusRowProps = { label: string; value: React.ReactNode; onClick?: () => void };

function StatusRow({ label, value, onClick }: StatusRowProps) {
    return (
        <SettingRow label={label}>
            {onClick
                ? <button type="button" onClick={onClick} className="w-full rounded-md px-2 py-1 text-left text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] md:text-right">{value}</button>
                : <div className="px-2 text-[13px] font-medium text-[var(--text-primary)] md:text-right">{value}</div>}
        </SettingRow>
    );
}

type LimitsStatusProps = { t: TranslateFn; onNavigateToTab: ((tab: string) => void) | undefined; status: LimitsStatus; kbProvider: string; cpuRerankerEnabled: boolean };

/** What this server will use right now; the first two rows jump to the section that controls them. */
function LimitsStatus({ t, onNavigateToTab, status, kbProvider, cpuRerankerEnabled }: LimitsStatusProps) {
    const warn = 'text-[var(--warning-ink)]';
    const search = status.searchProvider === 'node-search' ? t('admin_ai_config.limits_search_cloud', 'Cloud-only (Serper + provider APIs)')
        : status.searchProvider === 'bing' ? t('admin_ai_config.limits_search_bing', 'Azure Bing Web Search')
            : status.searchProvider === 'disabled' ? t('admin_ai_config.disabled', 'Disabled')
                : t('admin_ai_config.limits_search_self', 'Self-hosted (Agent Search + Serper)');
    return (
        <SettingsGroup
            title={t('admin_ai_config.limits_status_title', 'Setup status')}
            description={t('admin_ai_config.limits_status_hint', 'What this server will use right now. Click a row to jump to the tab that controls it.')}
        >
            <SettingsList>
                <StatusRow
                    label={t('admin_ai_config.limits_embed_model', 'Embedding model (global)')}
                    onClick={() => onNavigateToTab?.('embeddings')}
                    value={status.embedModel
                        ? `${status.embedModel}${status.embedProvider ? ` · ${status.embedProvider}` : ''}`
                        : <span className={warn}>{t('admin_ai_config.limits_embed_not_set', 'Not set: pick one in Embeddings')}</span>}
                />
                <StatusRow
                    label={t('admin_ai_config.limits_search_provider', 'Web search provider')}
                    onClick={() => onNavigateToTab?.('webSearchInference')}
                    value={(
                        <>
                            {search}
                            {(status.searchProvider === 'node-search' && !status.hasSerperKey) && <span className={`ml-2 ${warn}`}>{t('admin_ai_config.limits_needs_serper', '· needs Serper key')}</span>}
                            {(status.searchProvider === 'agent-search' && !status.hasAgentSearchUrl) && <span className={`ml-2 ${warn}`}>{t('admin_ai_config.limits_needs_search_url', '· needs SEARCH_SERVICE_URL')}</span>}
                        </>
                    )}
                />
                <StatusRow
                    label={t('admin_ai_config.limits_kb_provider', 'KB provider')}
                    value={kbProvider === 'auto' ? t('admin_ai_config.limits_kb_auto', 'Auto') : kbProvider === 'local' ? t('admin_ai_config.limits_kb_local', 'Local (in-process)') : t('admin_ai_config.limits_kb_remote', 'Remote search-service')}
                />
                <StatusRow
                    label={t('admin_ai_config.limits_cpu_reranker', 'CPU cross-encoder reranker')}
                    value={cpuRerankerEnabled ? t('admin_ai_config.enabled', 'Enabled') : t('admin_ai_config.disabled', 'Disabled')}
                />
            </SettingsList>
        </SettingsGroup>
    );
}
