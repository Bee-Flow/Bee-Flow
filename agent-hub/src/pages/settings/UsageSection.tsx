import React, { useState, useMemo, useCallback } from 'react';
import { useUsageSubscription, useUsageTiers, useUsageReport } from '../../api/queries/settingsUsage';
import { useTranslation, type TranslateParams } from '../../hooks/useTranslation';
import {
    Bot, Filter, X, Cpu, Users, ChevronDown, Activity, BarChart3, Coins, ThumbsUp,
    type LucideIcon,
} from 'lucide-react';
import { useLicenseContext } from '../../components/licensing/LicenseContext';
import { useDeploymentMode } from '../../hooks/useDeploymentMode';
import { deriveRangeParams, USAGE_ALL_DAYS, buildModelTierMap, tierForModel } from '../../utils/usageHelpers';
import { currencySym, shortModel, formatDateRange } from './usage/format';
import { getSourceDetails } from './usage/widgets';
import RangeControl, { defaultRange } from './usage/RangeControl';
import OverviewTab from './usage/OverviewTab';
import AdoptionTab from './usage/adoption/AdoptionTab';
import SpendTab from './usage/spend/SpendTab';
import QualityTab from './usage/quality/QualityTab';
import type { StarterModel } from '../../api/runtimeTypes';
import type { DropdownOption } from './PreferencesSection.types';

/* ── Report tabs ─────────────────────────────────────────────────────────── */
// Safety & Integrations moved to Settings → Organisation → Privacy Shield →
// "What happened" (?tab=activity) — they are shield monitoring, not
// consumption reporting. This page keeps the money/usage reports.
const REPORT_TABS = [
    { id: 'overview', labelKey: 'usage.tab_overview', label: 'Overview', icon: BarChart3 },
    { id: 'adoption', labelKey: 'adoption.tab', label: 'Adoption', icon: Users },
    { id: 'spend', labelKey: 'usage.tab_spend', label: 'Spend', icon: Coins },
    { id: 'quality', labelKey: 'usage.tab_quality', label: 'Quality', icon: ThumbsUp },
];

/** Deep links: the retired Feedback and Terminations reports are Quality sub-tabs now. */
function resolveReport(id: string): { tab: string; sub?: string } | null {
    if (id === 'feedback' || id === 'terminations') return { tab: 'quality', sub: id };
    return REPORT_TABS.some(tab => tab.id === id) ? { tab: id } : null;
}

interface ReportTabBarProps {
    active: string;
    onChange: (id: string) => void;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    tabs?: { id: string; labelKey: string; label: string; icon: LucideIcon; }[];
}

const ReportTabBar = ({ active, onChange, t: translate, tabs = REPORT_TABS }: ReportTabBarProps) => (
    <div className="flex items-center gap-1 border-b border-[var(--border-subtle)]">
        {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = active === tab.id;
            return (
                <button key={tab.id} type="button" onClick={() => onChange(tab.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border-0 px-3 py-1.5 text-[13px] transition-colors hover:bg-[var(--bg-secondary)] ${isActive
                        ? 'bg-[var(--bg-secondary)] font-medium text-[var(--text-primary)]'
                        : 'bg-transparent font-normal text-[var(--text-secondary)]'}`}>
                    <Icon className={`h-[14px] w-[14px] ${isActive ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'}`} />
                    {translate(tab.labelKey, tab.label)}
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
        <div className={`flex items-center gap-[5px] rounded-lg border px-2.5 py-[5px] text-xs font-medium transition-all ${value
            ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
            : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-secondary)]'}`}>
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

type StarterTiers = { fast?: StarterModel; standard?: StarterModel; thinking?: StarterModel };
const EMPTY_TIER_MAP: Record<string, string> = {};
const EMPTY_USAGE: UsageData = { summary: null, timeline: [], users: [], sources: [], agents: [], models: [], modelsByAgent: [], modelsByUser: [] };
const EMPTY_AZURE: AzureServicesData = { summary: null, byType: [], byUser: [] };

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
    // initialReport lets deep links open a specific report tab (and sub-tab). Unknown
    // values — including the RETIRED 'safety'/'integrations' ids from old bookmarks —
    // fall back to overview; the license bounce below still wins for non-Enterprise
    // orgs. (Those reports now live on the Privacy Shield's Activity tab.)
    // `nonce` remounts the tab, so a new deep link or onOpenTab re-seeds its sub-tab.
    const [nav, setNav] = useState(() => ({ ...(resolveReport(initialReport) ?? { tab: 'overview' }), nonce: 0 }));
    const activeReport = canSeeAdvancedUsage ? nav.tab : 'overview';
    // Re-clicking the active tab keeps its state (open rows, group filter, a revealed people list);
    // only a different tab or an explicit sub-tab remounts.
    const openTab = useCallback((tab: string, sub?: string) => setNav(n => (
        tab === n.tab && sub === undefined ? n : { tab, sub, nonce: n.nonce + 1 }
    )), []);
    const [compare, setCompare] = useState(true);

    const [prevInitialReport, setPrevInitialReport] = useState(initialReport);
    if (prevInitialReport !== initialReport) {
        setPrevInitialReport(initialReport);
        const target = resolveReport(initialReport);
        if (initialReport && target) openTab(target.tab, target.sub);
    }

    // Subscription (customer-view header: plan, billing, cost cap).
    const subscription = useUsageSubscription().data ?? null;

    // Model → tier map (cloud view badges).
    // Raw tiers config retained so the customer "By tier" breakdown can resolve
    // custom-tier display labels (tierLabel needs the tier object for `custom:*`).
    const tiersRaw = useUsageTiers<Parameters<typeof buildModelTierMap>[0]>().data;
    const modelTierMap = useMemo(() => (tiersRaw ? buildModelTierMap(tiersRaw) : EMPTY_TIER_MAP), [tiersRaw]);
    const modelTiers: StarterTiers = useMemo(
        () => (tiersRaw && typeof tiersRaw === 'object' ? tiersRaw as StarterTiers : {}), [tiersRaw]);
    const tierFor = useCallback((model: string | null) => tierForModel(modelTierMap, model), [modelTierMap]);

    // Cross-cutting filters
    const [filterUser, setFilterUser] = useState<string | null>(null);
    const [filterAgent, setFilterAgent] = useState<string | null>(null);
    const [filterModel, setFilterModel] = useState<string | null>(null);
    const [filterSource, setFilterSource] = useState<string | null>(null);
    const hasFilters = filterUser || filterAgent || filterModel || filterSource;
    const clearFilters = () => { setFilterUser(null); setFilterAgent(null); setFilterModel(null); setFilterSource(null); };

    // The query string of the current range and filters. A customer view has no model filter pill, so a
    // stale model filter must never scope it (`customerView` follows the report, see below).
    const [customerView, setCustomerView] = useState(false);
    const qs = useMemo(() => {
        const params = new URLSearchParams();
        // Always send a day count (works with today's days-only usage routes);
        // also send startDate/endDate so the routes use the exact window once the
        // backend tweak ships. 'all' → large day fallback.
        params.set('days', String(rangeParams.days ?? USAGE_ALL_DAYS));
        if (rangeParams.startDate) params.set('startDate', rangeParams.startDate);
        if (rangeParams.endDate) params.set('endDate', rangeParams.endDate);
        if (filterUser) params.set('user', filterUser);
        if (filterAgent) params.set('agent', filterAgent);
        if (filterModel && !customerView) params.set('model', filterModel);
        if (filterSource) params.set('source', filterSource);
        return params.toString();
    }, [rangeParams, filterUser, filterAgent, filterModel, filterSource, customerView]);

    // The previous report stays on screen while the next loads.
    const report = useUsageReport<UsageData, AzureServicesData>(qs);
    const loading = report.isFetching;
    const data: UsageData = report.data?.data ?? EMPTY_USAGE;
    const azureServices: AzureServicesData = report.data?.azure ?? EMPTY_AZURE;

    // Backend redacts token/call counts for cloud non-admin customers and swaps
    // estimated_cost for marked-up billed_cost. Detect that shape.
    const isCustomerView = Boolean(data.summary && data.summary.total_calls === undefined && data.summary.billed_cost !== undefined);
    // Single source of truth for token visibility: self-hosted always; cloud only
    // for admins (who keep total_calls). Defaults to hidden in cloud until the
    // summary loads, so tokens never flash for a customer.
    const showTokens = isSelfHosted || (data.summary != null && !isCustomerView);

    if (isCustomerView !== customerView) setCustomerView(isCustomerView);

    // Filter dropdown options
    const userOptions = useMemo(() => data.users.map(u => ({ value: u.user_id, label: u.display_name || u.user_id })), [data.users]);
    const agentOptions = useMemo(() => data.agents.map(a => ({ value: a.agent_id || a.agent_name, label: a.agent_name || 'Direct Chat' })), [data.agents]);
    const modelOptions = useMemo(() => data.models.map(m => ({ value: m.model, label: shortModel(m.model) })), [data.models]);
    const sourceOptions = useMemo(() => data.sources.map(s => ({ value: s.source, label: getSourceDetails(s.source, t).label })), [data.sources, t]);

    // Adoption and Quality read their own endpoints: the cross-cutting
    // user/agent/model/source filters and the usage skeleton only apply to
    // Overview and Spend.
    const isUsageTab = activeReport === 'overview' || activeReport === 'spend';
    const rangeLabel = formatDateRange(rangeParams.startDate, rangeParams.endDate);
    const billing = (subscription as { billing?: { plan_currency?: string } | null } | null)?.billing;

    const usageProps = {
        t, data, subscription, isCustomerView, showTokens, tierForModel: tierFor, modelTiers, azureServices,
        setFilterUser, setFilterModel, setFilterSource, compare, onOpenTab: openTab,
        rangeParams, rangePreset: range.preset, hasFilters: Boolean(hasFilters),
    };

    return (
        <div className="[display:flex] [flex-direction:column] [gap:16px] [padding-bottom:24px]">
            {/* Page header + global range control */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                    <h2 data-tour="usage-summary" className="text-lg font-semibold text-[var(--text-primary)]">{t('usage.title')}</h2>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                        {t('usage.subtitle')}{rangeLabel ? ` · ${rangeLabel}` : ''}
                    </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                    <RangeControl range={range} onChange={setRange} t={t} />
                    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                        <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />
                        {t('usage.compare_previous', 'Compare with previous period')}
                    </label>
                </div>
            </div>

            <ReportTabBar active={activeReport} onChange={openTab} t={t} tabs={visibleTabs} />

            {/* Cross-cutting filter bar — Overview and Spend only */}
            {isUsageTab && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2.5 py-1.5">
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
            )}

            {loading && isUsageTab ? (
                <div className="[display:flex] [flex-direction:column] [gap:12px]">
                    <div className="[display:grid] [grid-template-columns:repeat(4,1fr)] [gap:10px]">
                        {[1, 2, 3, 4].map(i => <div key={i} className="h-[80px] [border-radius:12px] [background:var(--bg-tertiary)] [animation:pulse_1.5s_ease-in-out_infinite]" />)}
                    </div>
                    <div className="h-[90px] [border-radius:12px] [background:var(--bg-tertiary)] [animation:pulse_1.5s_ease-in-out_infinite]" />
                </div>
            ) : (
                <>
                    {activeReport === 'overview' && <OverviewTab {...usageProps} />}
                    {activeReport === 'spend' && <SpendTab {...usageProps} key={nav.nonce} initialSubTab={nav.sub} />}
                    {activeReport === 'adoption' && (
                        <AdoptionTab
                            key={nav.nonce} rangeParams={rangeParams} rangePreset={range.preset} showTokens={showTokens}
                            currency={currencySym(billing?.plan_currency || 'EUR')} compare={compare}
                            initialSubTab={nav.sub} onOpenTab={openTab}
                        />
                    )}
                    {activeReport === 'quality' && (
                        <QualityTab key={nav.nonce} rangeParams={rangeParams} showTokens={showTokens} compare={compare} initialSubTab={nav.sub}
                            // The feedback and termination counts are org-wide; a filtered call count would skew their share.
                            totalCalls={hasFilters ? undefined : data.summary?.total_calls} />
                    )}
                </>
            )}
        </div>
    );
};

export default UsageSection;
