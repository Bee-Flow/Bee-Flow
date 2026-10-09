// "Search" section of the IntegrationsAdminPanel (search provider, Bing,
// Serper and Agent Search defaults). Subtree moved verbatim from
// IntegrationsAdminPanel.jsx; all bindings are threaded in as props.
import { Check, Loader2, Settings } from 'lucide-react';
import React from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';

export default function SearchSection({
    searchProvider, setSearchProvider,
    bingSearchKey, setBingSearchKey, hasBingSearchKey, setHasBingSearchKey,
    bingSearchMarket, setBingSearchMarket, savingBingKey, setSavingBingKey,
    agentSearchUrl, hasAgentSearchUrl,
    serperApiKey, setSerperApiKey, hasSerperKey, setHasSerperKey,
    savingSerperKey, setSavingSerperKey,
    agentSearchDefaults, setAgentSearchDefaults, savingSearchDefaults, setSavingSearchDefaults,
    setMessage,
}) {
    const { t } = useTranslation();
    return (
            <div className="p-6">
            <div className="max-w-4xl mx-auto space-y-8">
                {/* Global API Keys for Integrations */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <Settings className="w-4 h-4" /> {t('integ.search_agent_search_configuration', 'Agent Search Configuration')}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {t('integ.search_configure_your_self_hosted_agent', 'Configure your self-hosted Agent Search service.')}
                        </p>
                    </div>
                    <div className="p-6 space-y-4">
                        {/* Search Provider Selector */}
                        <div>
                            <label className="text-sm font-medium flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
                                {t('integ.search_search_provider', 'Search Provider')}
                            </label>
                            <div className="flex gap-2">
                                <select
                                    value={searchProvider}
                                    onChange={async (e) => {
                                        const val = e.target.value;
                                        setSearchProvider(val);
                                        try {
                                            const res = await authFetch(`${API_BASE}/ai/config`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ searchProvider: val }),
                                            });
                                            if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                            const labels = { 'disabled': 'Disabled', 'bing': 'Azure Bing Search', 'node-search': 'Cloud-only (Serper + provider APIs)', 'agent-search': 'Self-hosted Agent Search' };
                                            setMessage({ type: 'success', text: `Search provider set to ${labels[val] || val}` });
                                        } catch (e) {
                                            setMessage({ type: 'error', text: 'Failed to save search provider' });
                                        }
                                        setTimeout(() => setMessage(null), 3000);
                                    }}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                >
                                    <option value="agent-search">{t('integ.search_self_hosted_agent_search_serper', 'Self-hosted (Agent Search + Serper)')}</option>
                                    <option value="node-search">{t('integ.search_cloud_only_serper_provider_apis', 'Cloud-only (Serper + provider APIs)')}</option>
                                    <option value="bing">{t('integ.search_azure_bing_web_search', 'Azure Bing Web Search')}</option>
                                    <option value="disabled">{t('integ.search_disabled', 'Disabled')}</option>
                                </select>
                            </div>
                            <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                {t('integ.search_choose_which_search_provider_powers', 'Choose which search provider powers web search for AI agents. Select "Disabled" to turn off web search entirely.')}
                            </p>
                        </div>

                        {/* Bing Search Settings — only shown when Bing is selected */}
                        {searchProvider === 'bing' && (
                            <>
                                <div className="pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                                    <label className="text-sm font-medium flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
                                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                                        {t('integ.search_bing_search_api_key', 'Bing Search API Key')}
                                        {hasBingSearchKey && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.search_configured', 'Configured')}</span>}
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            type="password"
                                            value={bingSearchKey}
                                            onChange={e => setBingSearchKey(e.target.value)}
                                            placeholder={hasBingSearchKey ? '••••••••••••••••' : 'Enter Bing Search API subscription key'}
                                            className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                        />
                                        <button
                                            onClick={async () => {
                                                setSavingBingKey(true);
                                                try {
                                                    const res = await authFetch(`${API_BASE}/ai/config`, {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ bingSearchKey, bingSearchMarket }),
                                                    });
                                                    if (res.ok) {
                                                        setHasBingSearchKey(!!bingSearchKey);
                                                        setBingSearchKey('');
                                                        setMessage({ type: 'success', text: bingSearchKey ? 'Bing Search settings saved' : 'Bing Search key removed' });
                                                    }
                                                } catch (e) {
                                                    setMessage({ type: 'error', text: 'Failed to save Bing settings' });
                                                }
                                                setSavingBingKey(false);
                                                setTimeout(() => setMessage(null), 3000);
                                            }}
                                            disabled={savingBingKey}
                                            className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                            style={{ background: 'var(--accent-primary)', color: '#fff' }}
                                        >
                                            {savingBingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                            {t('integ.search_save', 'Save')}
                                        </button>
                                    </div>
                                    <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                        {t('integ.search_get_your_key_from', 'Get your key from')} <a href="https://portal.azure.com/#create/microsoft.bingsearch" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('integ.search_azure_portal_bing_search_v7', 'Azure Portal → Bing Search v7')}</a>.
                                    </p>
                                </div>
                                <div>
                                    <label className="text-sm font-medium flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
                                        {t('integ.search_market_optional', 'Market (optional)')}
                                    </label>
                                    <input
                                        type="text"
                                        value={bingSearchMarket}
                                        onChange={e => setBingSearchMarket(e.target.value)}
                                        placeholder={t('integ.search_e_g_nl_nl_en_us_leave_empty_for_auto', 'e.g. nl-NL, en-US (leave empty for auto)')}
                                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                    />
                                    <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                        {t('integ.search_set_the_market_for_locale_aware', 'Set the market for locale-aware results (e.g. nl-NL for Dutch). Leave empty for auto-detection.')}
                                    </p>
                                </div>
                            </>
                        )}

                        {/* Self-hosted Agent Search Service URL — only when agent-search */}
                        {searchProvider === 'agent-search' && (
                            <div className="space-y-4">
                                <div>
                                    <label className="text-sm font-medium flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
                                        {t('integ.search_agent_search_service_url', 'Agent Search Service URL')}
                                        {hasAgentSearchUrl && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.search_configured', 'Configured')}</span>}
                                    </label>
                                    <div className="px-3 py-2 rounded-lg text-sm border" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                                        {agentSearchUrl || <span style={{ color: 'var(--text-muted)' }}>{t('integ.search_not_configured_set_search_service_url', 'Not configured — set SEARCH_SERVICE_URL env var')}</span>}
                                    </div>
                                    <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                        {t('integ.search_controlled_by_the', 'Controlled by the')} <code>SEARCH_SERVICE_URL</code> {t('integ.search_environment_variable_on_the_server', 'environment variable on the server.')}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Node-search hint — only when node-search */}
                        {searchProvider === 'node-search' && (
                            <div className="px-3 py-2.5 rounded-lg text-sm border" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                                {t('integ.search_no_gpu_service_required_the_search', 'No GPU service required — the search loop (SERP, page fetch, embed, rerank, cleanup) runs in this server using the providers configured under')} <strong>{t('integ.search_ai_configuratie_web_search_inference', 'AI Configuratie → Web Search Inference')}</strong>.
                            </div>
                        )}

                        {/* Serper API Key — shown for both agent-search and node-search */}
                        {(searchProvider === 'agent-search' || searchProvider === 'node-search') && (
                            <div className="space-y-4">
                                <div className="pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                                    <label className="text-sm font-medium flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
                                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                                        {t('integ.search_serper_dev_api_key', 'Serper.dev API Key')}
                                        {hasSerperKey && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.search_configured', 'Configured')}</span>}
                                    </label>
                                    <div className="flex gap-2">
                                        <input
                                            type="password"
                                            value={serperApiKey}
                                            onChange={e => setSerperApiKey(e.target.value)}
                                            placeholder={hasSerperKey ? '••••••••••••••••' : 'Enter Serper.dev API key'}
                                            className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                        />
                                        <button
                                            onClick={async () => {
                                                setSavingSerperKey(true);
                                                try {
                                                    const res = await authFetch(`${API_BASE}/ai/config`, {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ serperApiKey }),
                                                    });
                                                    if (res.ok) {
                                                        setHasSerperKey(!!serperApiKey);
                                                        setSerperApiKey('');
                                                        setMessage({ type: 'success', text: serperApiKey ? 'Serper API key saved' : 'Serper API key removed' });
                                                    }
                                                } catch (e) {
                                                    setMessage({ type: 'error', text: 'Failed to save Serper API key' });
                                                }
                                                setSavingSerperKey(false);
                                                setTimeout(() => setMessage(null), 3000);
                                            }}
                                            disabled={savingSerperKey}
                                            className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                            style={{ background: 'var(--accent-primary)', color: '#fff' }}
                                        >
                                            {savingSerperKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                            {t('integ.search_save', 'Save')}
                                        </button>
                                    </div>
                                    <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                                        {t('integ.search_get_your_api_key_from', 'Get your API key from')} <a href="https://serper.dev" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>serper.dev</a>{t('integ.search_used_by_the_search_service_for_google', '. Used by the search service for Google web search results.')}
                                    </p>
                                </div>
                            </div>
                        )}

                        {(searchProvider === 'agent-search' || searchProvider === 'node-search') && (
                            <div className="mt-4 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                                <label className="text-sm font-medium flex items-center gap-2 mb-3" style={{ color: 'var(--text-primary)' }}>
                                    <Settings className="w-4 h-4" /> {t('integ.search_agent_search_default_options', 'Agent Search Default Options')}
                                </label>

                                {/* Global settings */}
                                <div className="grid grid-cols-2 gap-3 mb-4">
                                    <div>
                                        <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_default_mode', 'Default Mode')}</label>
                                        <select
                                            value={agentSearchDefaults.mode}
                                            onChange={e => setAgentSearchDefaults(p => ({ ...p, mode: e.target.value }))}
                                            className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                        >
                                            <option value="web">{t('integ.search_web_full_pages_reranking', 'Web (full pages + reranking)')}</option>
                                            <option value="web_fast">{t('integ.search_web_fast_snippets_only', 'Web Fast (snippets only)')}</option>
                                            <option value="kb">{t('integ.search_knowledge_base', 'Knowledge Base')}</option>
                                            <option value="auto">{t('integ.search_auto_kb_web_fallback', 'Auto (KB + web fallback)')}</option>
                                        </select>
                                    </div>
                                    <div className="flex items-end pb-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={agentSearchDefaults.include_citations}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, include_citations: e.target.checked }))}
                                                className="rounded"
                                            />
                                            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{t('integ.search_include_citations', 'Include citations')}</span>
                                        </label>
                                    </div>
                                </div>

                                {/* Web Mode Settings */}
                                <div className="rounded-lg border p-3 mb-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}>
                                    <div className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2" style={{ color: 'var(--accent-primary)' }}>
                                        {t('integ.search_web_mode', '🌐 Web Mode')}
                                        <span className="font-normal normal-case" style={{ color: 'var(--text-muted)' }}>{t('integ.search_full_page_content_reranking', '— full page content + reranking')}</span>
                                    </div>
                                    <div className="grid grid-cols-4 gap-3">
                                        <div>
                                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_max_results', 'Max Results')}</label>
                                            <input
                                                type="number" min="1" max="10"
                                                value={agentSearchDefaults.web?.max_results || 5}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, web: { ...p.web, max_results: parseInt(e.target.value) || 5 } }))}
                                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_fetch_top_n', 'Fetch Top N')}</label>
                                            <input
                                                type="number" min="1" max="5"
                                                value={agentSearchDefaults.web?.fetch_top_n || 3}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, web: { ...p.web, fetch_top_n: parseInt(e.target.value) || 3 } }))}
                                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_max_tokens', 'Max Tokens')}</label>
                                            <input
                                                type="number" min="500" max="5000" step="100"
                                                value={agentSearchDefaults.web?.max_tokens_markdown || 2000}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, web: { ...p.web, max_tokens_markdown: parseInt(e.target.value) || 2000 } }))}
                                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_detail_level', 'Detail Level')}</label>
                                            <select
                                                value={agentSearchDefaults.web?.detail_level || 'detailed'}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, web: { ...p.web, detail_level: e.target.value } }))}
                                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            >
                                                <option value="basic">{t('integ.search_basic_compact', 'Basic (compact)')}</option>
                                                <option value="detailed">{t('integ.search_detailed_default', 'Detailed (default)')}</option>
                                                <option value="highly_detailed">{t('integ.search_highly_detailed', 'Highly Detailed')}</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                {/* Web Fast Mode Settings */}
                                <div className="rounded-lg border p-3 mb-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-primary)' }}>
                                    <div className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2" style={{ color: '#f59e0b' }}>
                                        {t('integ.search_web_fast_mode', '⚡ Web Fast Mode')}
                                        <span className="font-normal normal-case" style={{ color: 'var(--text-muted)' }}>{t('integ.search_snippets_ai_synthesis', '— snippets + AI synthesis')}</span>
                                    </div>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div>
                                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_max_results', 'Max Results')}</label>
                                            <input
                                                type="number" min="1" max="20"
                                                value={agentSearchDefaults.web_fast?.max_results || 10}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, web_fast: { ...p.web_fast, max_results: parseInt(e.target.value) || 10 } }))}
                                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_max_tokens', 'Max Tokens')}</label>
                                            <input
                                                type="number" min="500" max="5000" step="100"
                                                value={agentSearchDefaults.web_fast?.max_tokens_markdown || 1500}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, web_fast: { ...p.web_fast, max_tokens_markdown: parseInt(e.target.value) || 1500 } }))}
                                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('integ.search_detail_level', 'Detail Level')}</label>
                                            <select
                                                value={agentSearchDefaults.web_fast?.detail_level || 'detailed'}
                                                onChange={e => setAgentSearchDefaults(p => ({ ...p, web_fast: { ...p.web_fast, detail_level: e.target.value } }))}
                                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            >
                                                <option value="basic">{t('integ.search_basic_compact', 'Basic (compact)')}</option>
                                                <option value="detailed">{t('integ.search_detailed_default', 'Detailed (default)')}</option>
                                                <option value="highly_detailed">{t('integ.search_highly_detailed', 'Highly Detailed')}</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex justify-end">
                                    <button
                                        onClick={async () => {
                                            setSavingSearchDefaults(true);
                                            try {
                                                const res = await authFetch(`${API_BASE}/ai/agent-search/defaults`, {
                                                    method: 'PUT',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify(agentSearchDefaults),
                                                });
                                                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                                setMessage({ type: 'success', text: 'Agent Search defaults saved' });
                                            } catch (e) {
                                                setMessage({ type: 'error', text: 'Failed to save defaults' });
                                            }
                                            setSavingSearchDefaults(false);
                                            setTimeout(() => setMessage(null), 3000);
                                        }}
                                        disabled={savingSearchDefaults}
                                        className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                        style={{ background: 'var(--accent-primary)', color: '#fff' }}
                                    >
                                        {savingSearchDefaults ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                        {t('integ.search_save_defaults', 'Save Defaults')}
                                    </button>
                                </div>
                            </div>
                        )}
                        </div>
                    </div>

            </div>
            </div>
    );
}
