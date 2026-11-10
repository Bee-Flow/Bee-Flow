// "Search" section of the IntegrationsAdminPanel: which provider powers web
// search for agents, its credentials (Bing, Serper) and the Agent Search
// defaults. The bindings are threaded in as props from the panel.
import type React from 'react';
import { API_BASE } from '@/utils/helpers';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_INFO } from '@/components/mcpLibrary/ui';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, Field, FieldGrid, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import type { SearchSectionProps } from './adminPanel.types';
import { HINT_LINK, SaveButton, StatusChip } from './ui';
import { mutate, ApiError } from '@/api/mutate';

const MASK = '••••••••••••••••';
const PROVIDER_LABELS: Record<string, string> = { 'disabled': 'Disabled', 'bing': 'Azure Bing Search', 'node-search': 'Cloud-only (Serper + provider APIs)', 'agent-search': 'Self-hosted Agent Search' };

/** A mutate whose refusal is an Error, so the caller's catch reports it. */
async function send(url: string, method: string, body: unknown) {
    try {
        await mutate(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        throw new Error(`HTTP ${err.status}`);
    }
}

/** POST /ai/config; null when the server refused. */
function postConfig(body: unknown) {
    return mutate(`${API_BASE}/ai/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .catch((err: unknown) => {
            if (err instanceof ApiError) return null;
            throw err;
        });
}

function ProviderRow({ searchProvider, setSearchProvider, setMessage }: Pick<SearchSectionProps, 'searchProvider' | 'setSearchProvider' | 'setMessage'>) {
    const { t } = useTranslation();
    const change = async (val: string) => {
        setSearchProvider(val);
        try {
            await send(`${API_BASE}/ai/config`, 'POST', { searchProvider: val });
            setMessage({ type: 'success', text: `Search provider set to ${PROVIDER_LABELS[val] || val}` });
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save search provider' });
        }
        setTimeout(() => setMessage(null), 3000);
    };
    return (
        <SettingRow
            htmlFor="search-provider"
            label={t('integ.search_search_provider', 'Search Provider')}
            hint={t('integ.search_choose_which_search_provider_powers', 'Choose which search provider powers web search for AI agents. Select "Disabled" to turn off web search entirely.')}
        >
            <select id="search-provider" value={searchProvider} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { void change(e.target.value); }} className={FIELD_INPUT}>
                <option value="agent-search">{t('integ.search_self_hosted_agent_search_serper', 'Self-hosted (Agent Search + Serper)')}</option>
                <option value="node-search">{t('integ.search_cloud_only_serper_provider_apis', 'Cloud-only (Serper + provider APIs)')}</option>
                <option value="bing">{t('integ.search_azure_bing_web_search', 'Azure Bing Web Search')}</option>
                <option value="disabled">{t('integ.search_disabled', 'Disabled')}</option>
            </select>
        </SettingRow>
    );
}

function BingRows(p: SearchSectionProps) {
    const { t } = useTranslation();
    const save = async () => {
        p.setSavingBingKey(true);
        try {
            if (await postConfig({ bingSearchKey: p.bingSearchKey, bingSearchMarket: p.bingSearchMarket })) {
                p.setHasBingSearchKey(!!p.bingSearchKey);
                p.setBingSearchKey('');
                p.setMessage({ type: 'success', text: p.bingSearchKey ? 'Bing Search settings saved' : 'Bing Search key removed' });
            }
        } catch (e) {
            p.setMessage({ type: 'error', text: 'Failed to save Bing settings' });
        }
        p.setSavingBingKey(false);
        setTimeout(() => p.setMessage(null), 3000);
    };
    return (
        <>
            <SettingRow
                // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential
                label={<span className="flex items-center gap-2">{t('integ.search_bing_search_api_key', 'Bing Search API Key')}{p.hasBingSearchKey && <StatusChip>{t('integ.search_configured', 'Configured')}</StatusChip>}</span>}
                hint={<>{t('integ.search_get_your_key_from', 'Get your key from')} <a href="https://portal.azure.com/#create/microsoft.bingsearch" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>{t('integ.search_azure_portal_bing_search_v7', 'Azure Portal → Bing Search v7')}</a>.</>}
            >
                <div className="flex gap-2">
                    <input type="password" value={p.bingSearchKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setBingSearchKey(e.target.value)} placeholder={p.hasBingSearchKey ? MASK : 'Enter Bing Search API subscription key'} className={FIELD_INPUT} />
                    <SaveButton saving={p.savingBingKey} onClick={save}>{t('integ.search_save', 'Save')}</SaveButton>
                </div>
            </SettingRow>
            <SettingRow htmlFor="bing-market" label={t('integ.search_market_optional', 'Market (optional)')} hint={t('integ.search_set_the_market_for_locale_aware', 'Set the market for locale-aware results (e.g. nl-NL for Dutch). Leave empty for auto-detection.')}>
                <input id="bing-market" type="text" value={p.bingSearchMarket} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setBingSearchMarket(e.target.value)} placeholder={t('integ.search_e_g_nl_nl_en_us_leave_empty_for_auto', 'e.g. nl-NL, en-US (leave empty for auto)')} className={FIELD_INPUT} />
            </SettingRow>
        </>
    );
}

function SerperRow(p: SearchSectionProps) {
    const { t } = useTranslation();
    const save = async () => {
        p.setSavingSerperKey(true);
        try {
            if (await postConfig({ serperApiKey: p.serperApiKey })) {
                p.setHasSerperKey(!!p.serperApiKey);
                p.setSerperApiKey('');
                p.setMessage({ type: 'success', text: p.serperApiKey ? 'Serper API key saved' : 'Serper API key removed' });
            }
        } catch (e) {
            p.setMessage({ type: 'error', text: 'Failed to save Serper API key' });
        }
        p.setSavingSerperKey(false);
        setTimeout(() => p.setMessage(null), 3000);
    };
    return (
        <SettingRow
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential
            label={<span className="flex items-center gap-2">{t('integ.search_serper_dev_api_key', 'Serper.dev API Key')}{p.hasSerperKey && <StatusChip>{t('integ.search_configured', 'Configured')}</StatusChip>}</span>}
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential
            hint={<>{t('integ.search_get_your_api_key_from', 'Get your API key from')} <a href="https://serper.dev" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>serper.dev</a>{t('integ.search_used_by_the_search_service_for_google', '. Used by the search service for Google web search results.')}</>}
        >
            <div className="flex gap-2">
                <input type="password" value={p.serperApiKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setSerperApiKey(e.target.value)} placeholder={p.hasSerperKey ? MASK : 'Enter Serper.dev API key'} className={FIELD_INPUT} />
                <SaveButton saving={p.savingSerperKey} onClick={save}>{t('integ.search_save', 'Save')}</SaveButton>
            </div>
        </SettingRow>
    );
}

function DetailSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
    const { t } = useTranslation();
    return (
        <select id={id} value={value} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)} className={FIELD_INPUT}>
            <option value="basic">{t('integ.search_basic_compact', 'Basic (compact)')}</option>
            <option value="detailed">{t('integ.search_detailed_default', 'Detailed (default)')}</option>
            <option value="highly_detailed">{t('integ.search_highly_detailed', 'Highly Detailed')}</option>
        </select>
    );
}

/** A number field of the defaults; an empty or invalid entry falls back to the default. */
function NumberField({ id, label, min, max, step, value, onChange }: { id: string; label: string; min: string; max: string; step?: string; value: number; onChange: (v: string) => void }) {
    return (
        <Field label={label} htmlFor={id}>
            <input id={id} type="number" min={min} max={max} step={step} value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)} className={FIELD_INPUT} />
        </Field>
    );
}

function DefaultsGroup({ agentSearchDefaults: d, setAgentSearchDefaults: set, savingSearchDefaults, setSavingSearchDefaults, setMessage }: SearchSectionProps) {
    const { t } = useTranslation();
    const save = async () => {
        setSavingSearchDefaults(true);
        try {
            await send(`${API_BASE}/ai/agent-search/defaults`, 'PUT', d);
            setMessage({ type: 'success', text: 'Agent Search defaults saved' });
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save defaults' });
        }
        setSavingSearchDefaults(false);
        setTimeout(() => setMessage(null), 3000);
    };
    return (
        <SettingsGroup title={t('integ.search_agent_search_default_options', 'Agent Search Default Options')}>
            <SettingsList>
                <SettingRow htmlFor="search-default-mode" label={t('integ.search_default_mode', 'Default Mode')}>
                    <select id="search-default-mode" value={d.mode} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set(p => ({ ...p, mode: e.target.value }))} className={FIELD_INPUT}>
                        <option value="web">{t('integ.search_web_full_pages_reranking', 'Web (full pages + reranking)')}</option>
                        <option value="web_fast">{t('integ.search_web_fast_snippets_only', 'Web Fast (snippets only)')}</option>
                        <option value="kb">{t('integ.search_knowledge_base', 'Knowledge Base')}</option>
                        <option value="auto">{t('integ.search_auto_kb_web_fallback', 'Auto (KB + web fallback)')}</option>
                    </select>
                </SettingRow>
                <SettingRow label={t('integ.search_include_citations', 'Include citations')}>
                    <div className="flex justify-end">
                        <Toggle checked={d.include_citations} onChange={(next) => set(p => ({ ...p, include_citations: next }))} ariaLabel={t('integ.search_include_citations', 'Include citations')} />
                    </div>
                </SettingRow>
                <SettingRow
                    label={t('integ.search_web_mode', '🌐 Web Mode')}
                    hint={t('integ.search_full_page_content_reranking', '— full page content + reranking')}
                    expanded={(
                        <FieldGrid>
                            <NumberField id="web-max-results" label={t('integ.search_max_results', 'Max Results')} min="1" max="10" value={d.web?.max_results || 5} onChange={v => set(p => ({ ...p, web: { ...p.web, max_results: parseInt(v) || 5 } }))} />
                            <NumberField id="web-fetch-top" label={t('integ.search_fetch_top_n', 'Fetch Top N')} min="1" max="5" value={d.web?.fetch_top_n || 3} onChange={v => set(p => ({ ...p, web: { ...p.web, fetch_top_n: parseInt(v) || 3 } }))} />
                            <NumberField id="web-max-tokens" label={t('integ.search_max_tokens', 'Max Tokens')} min="500" max="5000" step="100" value={d.web?.max_tokens_markdown || 2000} onChange={v => set(p => ({ ...p, web: { ...p.web, max_tokens_markdown: parseInt(v) || 2000 } }))} />
                            <Field label={t('integ.search_detail_level', 'Detail Level')} htmlFor="web-detail">
                                <DetailSelect id="web-detail" value={d.web?.detail_level || 'detailed'} onChange={v => set(p => ({ ...p, web: { ...p.web, detail_level: v } }))} />
                            </Field>
                        </FieldGrid>
                    )}
                />
                <SettingRow
                    label={t('integ.search_web_fast_mode', '⚡ Web Fast Mode')}
                    hint={t('integ.search_snippets_ai_synthesis', '— snippets + AI synthesis')}
                    expanded={(
                        <FieldGrid>
                            <NumberField id="fast-max-results" label={t('integ.search_max_results', 'Max Results')} min="1" max="20" value={d.web_fast?.max_results || 10} onChange={v => set(p => ({ ...p, web_fast: { ...p.web_fast, max_results: parseInt(v) || 10 } }))} />
                            <NumberField id="fast-max-tokens" label={t('integ.search_max_tokens', 'Max Tokens')} min="500" max="5000" step="100" value={d.web_fast?.max_tokens_markdown || 1500} onChange={v => set(p => ({ ...p, web_fast: { ...p.web_fast, max_tokens_markdown: parseInt(v) || 1500 } }))} />
                            <Field label={t('integ.search_detail_level', 'Detail Level')} htmlFor="fast-detail">
                                <DetailSelect id="fast-detail" value={d.web_fast?.detail_level || 'detailed'} onChange={v => set(p => ({ ...p, web_fast: { ...p.web_fast, detail_level: v } }))} />
                            </Field>
                        </FieldGrid>
                    )}
                />
            </SettingsList>
            <div>
                <SaveButton saving={savingSearchDefaults} onClick={save}>{t('integ.search_save_defaults', 'Save Defaults')}</SaveButton>
            </div>
        </SettingsGroup>
    );
}

export default function SearchSection(props: SearchSectionProps) {
    const { t } = useTranslation();
    const { searchProvider, agentSearchUrl, hasAgentSearchUrl } = props;
    const serperBased = searchProvider === 'agent-search' || searchProvider === 'node-search';
    return (
        <div className="flex max-w-4xl flex-col gap-8">
            <SectionHeader
                title={t('integ.search_agent_search_configuration', 'Agent Search Configuration')}
                description={t('integ.search_configure_your_self_hosted_agent', 'Configure your self-hosted Agent Search service.')}
            />
            <SettingsGroup title={t('integ.search_search_provider', 'Search Provider')}>
                <SettingsList>
                    <ProviderRow {...props} />
                    {searchProvider === 'bing' && <BingRows {...props} />}
                    {searchProvider === 'agent-search' && (
                        <SettingRow
                            label={<span className="flex items-center gap-2">{t('integ.search_agent_search_service_url', 'Agent Search Service URL')}{hasAgentSearchUrl && <StatusChip>{t('integ.search_configured', 'Configured')}</StatusChip>}</span>}
                            hint={<>{t('integ.search_controlled_by_the', 'Controlled by the')} <code>SEARCH_SERVICE_URL</code> {t('integ.search_environment_variable_on_the_server', 'environment variable on the server.')}</>}
                        >
                            <div className="truncate rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[13px] text-[var(--text-secondary)]">
                                {agentSearchUrl || <span className="text-[var(--text-tertiary)]">{t('integ.search_not_configured_set_search_service_url', 'Not configured — set SEARCH_SERVICE_URL env var')}</span>}
                            </div>
                        </SettingRow>
                    )}
                    {searchProvider === 'node-search' && (
                        <div className="px-4 py-3">
                            <p className={`m-0 ${ALERT_INFO}`}>
                                {t('integ.search_no_gpu_service_required_the_search', 'No GPU service required — the search loop (SERP, page fetch, embed, rerank, cleanup) runs in this server using the providers configured under')} <strong>{t('integ.search_ai_configuratie_web_search_inference', 'AI Configuratie → Web Search Inference')}</strong>.
                            </p>
                        </div>
                    )}
                    {serperBased && <SerperRow {...props} />}
                </SettingsList>
            </SettingsGroup>
            {serperBased && <DefaultsGroup {...props} />}
        </div>
    );
}
