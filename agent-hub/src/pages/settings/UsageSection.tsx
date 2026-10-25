import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';
import { useTranslation, type TranslateParams } from '../../hooks/useTranslation';
import {
    Bot, Filter, X, Cpu, Users, ChevronDown, Activity, BarChart3,
    AlertTriangle, ThumbsUp,
    type LucideIcon,
} from 'lucide-react';
import OrgFeedbackPanel from './OrgFeedbackPanel';
import OrgTerminationsPanel from './OrgTerminationsPanel';
import { useLicenseContext } from '../../components/licensing/LicenseContext';
import { useDeploymentMode } from '../../hooks/useDeploymentMode';
import { deriveRangeParams, USAGE_ALL_DAYS, buildModelTierMap, tierForModel } from '../../utils/usageHelpers';
import { shortModel } from './usage/format';
import { getSourceDetails } from './usage/widgets';
import RangeControl, { defaultRange } from './usage/RangeControl';
import OverviewTab from './usage/OverviewTab';
import type { StarterModel } from '../../api/runtimeTypes';
import type { DropdownOption } from './PreferencesSection.types';
import { logger } from '../../utils/logger';

/* ── Report tabs ─────────────────────────────────────────────────────────── */
// Safety & Integrations moved to Settings → Organisation → Privacy Shield →
// "What happened" (?tab=activity) — they are shield monitoring, not
// consumption reporting. This page keeps the money/usage reports.
const REPORT_TABS = [
    { id: 'overview', labelKey: 'usage.tab_overview', icon: BarChart3, color: '#0ea5e9' },
    { id: 'feedback', labelKey: 'usage.tab_feedback', icon: ThumbsUp, color: '#10b981' },
    { id: 'terminations', labelKey: 'usage.tab_terminations', icon: AlertTriangle, color: '#f43f5e' },
];

interface ReportTabBarProps {
    active: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    tabs?: { id: string; labelKey: string; icon: LucideIcon; color: string; }[];
}

const ReportTabBar = ({ active, onChange, t: translate, tabs = REPORT_TABS }: ReportTabBarProps) => (
    <div className="[display:flex] [align-items:center] [gap:4px] [border-bottom:1px_solid_var(--border-default,var(--border-subtle))]">
        {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = active === tab.id;
            return (
                <button key={tab.id} onClick={() => onChange(tab.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: isActive ? 'var(--bg-secondary)' : 'transparent',
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontWeight: isActive ? 500 : 400, fontSize: 13, transition: 'background 0.15s ease, color 0.15s ease',
                }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
                    <Icon style={{ width: 14, height: 14, color: isActive ? tab.color : 'var(--text-muted)' }} />
                    {translate(tab.labelKey)}
                </button>
            );
        })}
    </div>
);

/* ── Filter pill (Users / Agents / Models / Sources) ─────────────────────── */
interface FilterPillProps {
    icon: LucideIcon;
    value: string | number | readonly string[] | null;
    onChange: React.Dispatch<React.SetStateAction<string | null>>;
    options: DropdownOption[];
    placeholder: string;
}

const FilterPill = ({ icon: Icon, value, onChange, options, placeholder }: FilterPillProps) => (
    <div className="[position:relative]">
        <div style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8,
            background: value ? 'var(--accent-primary)' : 'var(--bg-primary)',
            border: `1px solid ${value ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
            fontSize: 12, fontWeight: 500, color: value ? '#fff' : 'var(--text-secondary)', transition: 'all 0.15s ease',
        }}>
            {Icon && <Icon className="w-[12px] h-[12px] [flex-shrink:0]" />}
            <select value={value || ''} onChange={(e) => onChange(e.target.value || null)} className="[background:transparent] [border:none] [outline:none] [color:inherit] [font-size:12px] [font-weight:500] [cursor:pointer] [appearance:none] [-webkit-appearance:none] min-w-[60px] [padding-right:14px]">
                <option value="">{placeholder}</option>
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown className="w-[11px] h-[11px] [position:absolute] [right:8px] [pointer-events:none] [opacity:0.5]" />
        </div>
    </div>
);

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  MAIN CONTAINER                                                            */
/* ═══════════════════════════════════════════════════════════════════════════ */
interface UsageData {
    summary: { total_calls?: number; billed_cost?: number } | null;
    timeline: unknown[];
    users: { user_id: string; display_name?: string }[];
    sources: { source: string }[];
    agents: { agent_id?: string; agent_name: string }[];
    models: { model: string }[];
    modelsByAgent: unknown[];
    modelsByUser: unknown[];
}

interface AzureServicesData {
    summary: Record<string, unknown> | null;
    byType: unknown[];
    byUser: unknown[];
}

interface UsageSectionProps {
    initialReport?: string;
}

const UsageSection = ({ initialReport = '' }: UsageSectionProps) => {
    const { t } = useTranslation();
    const { hasFeature: hasLicenseFeature } = useLicenseContext();
    const { isSelfHosted } = useDeploymentMode();

    // `advanced_usage_monitoring` (Enterprise+) gates every non-Overview tab.
    const canSeeAdvancedUsage = hasLicenseFeature('advanced_usage_monitoring');
    const visibleTabs = useMemo(
        () => canSeeAdvancedUsage ? REPORT_TABS : REPORT_TABS.filter(tab => tab.id === 'overview'),
        [canSeeAdvancedUsage]
    );

    const [range, setRange] = useState(() => defaultRange('30d'));
    const rangeParams = useMemo(() => deriveRangeParams(range), [range]);
    const [loading, setLoading] = useState(true);
    // initialReport lets deep links open a specific report tab. Unknown values
    // — including the RETIRED 'safety'/'integrations' ids from old bookmarks —
    // fall back to overview; the license bounce below still wins for
    // non-Enterprise orgs. (Those reports now live on the Privacy Shield's
    // Activity tab: /app/settings/organisation/privacy?tab=activity.)
    const [activeReport, setActiveReport] = useState(() =>
        REPORT_TABS.some(tab => tab.id === initialReport) ? initialReport : 'overview');

    const [prevInitialReport, setPrevInitialReport] = useState(initialReport);
    if (prevInitialReport !== initialReport) {
        setPrevInitialReport(initialReport);
        if (initialReport && REPORT_TABS.some(tab => tab.id === initialReport)) setActiveReport(initialReport);
    }

    if (!canSeeAdvancedUsage && activeReport !== 'overview') setActiveReport('overview');

    // Subscription (customer-view header: plan, billing, cost cap).
    const [subscription, setSubscription] = useState<Record<string, unknown> | null>(null);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const permsRes = await authFetch(`${API_BASE}/auth/my-permissions`);
                if (!permsRes.ok) return;
                const perms = await permsRes.json();
                const orgId = (perms?.organizations || [])[0];
                if (!orgId) return;
                const subRes = await authFetch(`${API_BASE}/api/subscriptions/orgs/${orgId}`);
                if (!subRes.ok) return;
                const sub = await subRes.json();
                if (!cancelled) setSubscription(sub);
            } catch (err) { logger.debug('non-fatal', err); }
        })();
        return () => { cancelled = true; };
    }, []);

    // Model → tier map (cloud view badges).
    const [modelTierMap, setModelTierMap] = useState<Record<string, string>>({});
    // Raw tiers config retained so the customer "By tier" breakdown can resolve
    // custom-tier display labels (tierLabel needs the tier object for `custom:*`).
    const [modelTiers, setModelTiers] = useState<{ fast?: StarterModel; standard?: StarterModel; thinking?: StarterModel }>({});
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`);
                if (!res.ok) return;
                const d = await res.json();
                const tiers = d?.tiers || d?.modelTiers || d;
                if (!cancelled) {
                    setModelTierMap(buildModelTierMap(tiers));
                    setModelTiers(tiers && typeof tiers === 'object' ? tiers : {});
                }
            } catch (err) { logger.debug('non-fatal — falls back to model-only badges', err); }
        })();
        return () => { cancelled = true; };
    }, []);
    const tierFor = useCallback((model: string | null) => tierForModel(modelTierMap, model), [modelTierMap]);

    // Cross-cutting filters
    const [filterUser, setFilterUser] = useState<string | null>(null);
    const [filterAgent, setFilterAgent] = useState<string | null>(null);
    const [filterModel, setFilterModel] = useState<string | null>(null);
    const [filterSource, setFilterSource] = useState<string | null>(null);
    const hasFilters = filterUser || filterAgent || filterModel || filterSource;
    const clearFilters = () => { setFilterUser(null); setFilterAgent(null); setFilterModel(null); setFilterSource(null); };

    const [data, setData] = useState<UsageData>({ summary: null, timeline: [], users: [], sources: [], agents: [], models: [], modelsByAgent: [], modelsByUser: [] });
    const [azureServices, setAzureServices] = useState<AzureServicesData>({ summary: null, byType: [], byUser: [] });

    // Backend redacts token/call counts for cloud non-admin customers and swaps
    // estimated_cost for marked-up billed_cost. Detect that shape.
    const isCustomerView = Boolean(data.summary && data.summary.total_calls === undefined && data.summary.billed_cost !== undefined);
    // Single source of truth for token visibility: self-hosted always; cloud only
    // for admins (who keep total_calls). Defaults to hidden in cloud until the
    // summary loads, so tokens never flash for a customer.
    const showTokens = isSelfHosted || (data.summary != null && !isCustomerView);

    const buildQS = useCallback(() => {
        const params = new URLSearchParams();
        // Always send a day count (works with today's days-only usage routes);
        // also send startDate/endDate so the routes use the exact window once the
        // backend tweak ships. 'all' → large day fallback.
        params.set('days', String(rangeParams.days ?? USAGE_ALL_DAYS));
        if (rangeParams.startDate) params.set('startDate', rangeParams.startDate);
        if (rangeParams.endDate) params.set('endDate', rangeParams.endDate);
        if (filterUser) params.set('user', filterUser);
        if (filterAgent) params.set('agent', filterAgent);
        // Customers see tiers, not models, and have no model filter pill — never
        // let a stale model filter scope their dashboard to a hidden model id.
        if (filterModel && !isCustomerView) params.set('model', filterModel);
        if (filterSource) params.set('source', filterSource);
        return params.toString();
    }, [rangeParams, filterUser, filterAgent, filterModel, filterSource, isCustomerView]);

    useEffect(() => {
        const fetchUsage = async () => {
            setLoading(true);
            try {
                const qs = buildQS();
                const sj = async (r: Response, fb: unknown) => { try { if (!r.ok) return fb; const d = await r.json(); return d?.error ? fb : d; } catch { return fb; } };
                const sa = async (r: Response) => { const d = await sj(r, []); return Array.isArray(d) ? d : []; };

                const eps = ['summary', 'timeline', 'users', 'sources', 'agents', 'models', 'models-by-agent', 'models-by-user'];
                const results = await Promise.all(eps.map(ep => authFetch(`${API_BASE}/api/usage/${ep}?${qs}`)));
                setData({
                    summary: await sj(results[0], {}),
                    timeline: await sa(results[1]),
                    users: await sa(results[2]),
                    sources: await sa(results[3]),
                    agents: await sa(results[4]),
                    models: await sa(results[5]),
                    modelsByAgent: await sa(results[6]),
                    modelsByUser: await sa(results[7]),
                });

                // The guardrails/integrations blocks (19 requests) left with
                // the Safety & Integrations tabs — see the Privacy Shield
                // Activity tab, which fetches its two consolidated overviews
                // only when it is actually open.
                const azEps = ['azure-services/summary', 'azure-services/by-type', 'azure-services/by-user'];
                const azResults = await Promise.all(azEps.map(ep => authFetch(`${API_BASE}/api/usage/${ep}?${qs}`)));
                setAzureServices({
                    summary: await sj(azResults[0], {}),
                    byType: await sa(azResults[1]),
                    byUser: await sa(azResults[2]),
                });
            } catch (err) { console.error('Failed to load usage', err); }
            setLoading(false);
        };
        fetchUsage();
    }, [buildQS]);

    // Filter dropdown options
    const userOptions = useMemo(() => data.users.map(u => ({ value: u.user_id, label: u.display_name || u.user_id })), [data.users]);
    const agentOptions = useMemo(() => data.agents.map(a => ({ value: a.agent_id || a.agent_name, label: a.agent_name || 'Direct Chat' })), [data.agents]);
    const modelOptions = useMemo(() => data.models.map(m => ({ value: m.model, label: shortModel(m.model) })), [data.models]);
    const sourceOptions = useMemo(() => data.sources.map(s => ({ value: s.source, label: getSourceDetails(s.source).label })), [data.sources]);

    const isPanelTab = activeReport === 'feedback' || activeReport === 'terminations';

    return (
        <div className="[display:flex] [flex-direction:column] [gap:16px] [padding-bottom:24px]">
            {/* Page header + global range control */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                    <h2 data-tour="usage-summary" className="text-lg font-semibold text-[var(--text-primary)]">{t('usage.title')}</h2>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">{t('usage.subtitle')}</p>
                </div>
                <RangeControl range={range} onChange={setRange} t={t} />
            </div>

            <ReportTabBar active={activeReport} onChange={setActiveReport} t={t} tabs={visibleTabs} />

            {/* Cross-cutting filter bar — usage tabs only */}
            <div style={{
                display: isPanelTab ? 'none' : 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                padding: '6px 10px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
            }}>
                <div className="[display:flex] [align-items:center] [gap:4px] [margin-right:2px]">
                    <Filter className="w-[12px] h-[12px] [color:var(--text-muted)]" />
                    <span className="[font-size:10px] [font-weight:700] [color:var(--text-muted)] [text-transform:uppercase] [letter-spacing:0.05em]">{t('usage.filters')}</span>
                </div>
                <FilterPill icon={Users} value={filterUser} onChange={setFilterUser} options={userOptions} placeholder={t('usage.all_users')} />
                <FilterPill icon={Bot} value={filterAgent} onChange={setFilterAgent} options={agentOptions} placeholder={t('usage.all_agents')} />
                {/* Model filter hidden in the customer view — models are abstracted to tiers there. */}
                {!isCustomerView && (
                    <FilterPill icon={Cpu} value={filterModel} onChange={setFilterModel} options={modelOptions} placeholder={t('usage.all_models')} />
                )}
                <FilterPill icon={Activity} value={filterSource} onChange={setFilterSource} options={sourceOptions} placeholder={t('usage.all_sources')} />
                {hasFilters && (
                    <button onClick={clearFilters} className="[display:flex] [align-items:center] [gap:4px] [padding:4px_8px] [border-radius:6px] [border:none] [background:var(--bg-tertiary)] [font-size:10px] [font-weight:600] [color:var(--text-muted)] [cursor:pointer]">
                        <X className="w-[10px] h-[10px]" /> {t('usage.clear')}
                    </button>
                )}
            </div>

            {loading && !isPanelTab ? (
                <div className="[display:flex] [flex-direction:column] [gap:12px]">
                    <div className="[display:grid] [grid-template-columns:repeat(4,1fr)] [gap:10px]">
                        {[1, 2, 3, 4].map(i => <div key={i} className="h-[80px] [border-radius:12px] [background:var(--bg-tertiary)] [animation:pulse_1.5s_ease-in-out_infinite]" />)}
                    </div>
                    <div className="h-[90px] [border-radius:12px] [background:var(--bg-tertiary)] [animation:pulse_1.5s_ease-in-out_infinite]" />
                </div>
            ) : (
                <>
                    {activeReport === 'overview' && (
                        <OverviewTab
                            t={t} data={data} subscription={subscription} isCustomerView={isCustomerView}
                            showTokens={showTokens} tierForModel={tierFor} modelTiers={modelTiers} azureServices={azureServices}
                            setFilterUser={setFilterUser} setFilterModel={setFilterModel} setFilterSource={setFilterSource}
                        />
                    )}
                    {activeReport === 'feedback' && <OrgFeedbackPanel rangeParams={rangeParams} showTokens={showTokens} />}
                    {activeReport === 'terminations' && <OrgTerminationsPanel rangeParams={rangeParams} showTokens={showTokens} />}
                </>
            )}
        </div>
    );
};

export default UsageSection;
