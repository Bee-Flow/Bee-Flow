import { useState, useMemo, useCallback } from 'react';
import { useTranslation, type TranslateParams } from '../../hooks/useTranslation';
import { Users, BarChart3, Coins, ThumbsUp, type LucideIcon } from 'lucide-react';
import { useLicenseContext } from '../../components/licensing/LicenseContext';
import { deriveRangeParams } from '../../utils/usageHelpers';
import { formatDateRange } from './usage/format';
import RangeControl, { defaultRange } from './usage/RangeControl';
import UsageReports from './usage/UsageReports';

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

interface UsageSectionProps {
    initialReport?: string;
}

const UsageSection = ({ initialReport = '' }: UsageSectionProps) => {
    const { t } = useTranslation();
    const { hasFeature: hasLicenseFeature } = useLicenseContext();

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

    const [prevInitialReport, setPrevInitialReport] = useState(initialReport);
    if (prevInitialReport !== initialReport) {
        setPrevInitialReport(initialReport);
        const target = resolveReport(initialReport);
        if (initialReport && target) openTab(target.tab, target.sub);
    }
    const rangeLabel = formatDateRange(rangeParams.startDate, rangeParams.endDate);

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
                <RangeControl range={range} onChange={setRange} t={t} />
            </div>

            <ReportTabBar active={activeReport} onChange={openTab} t={t} tabs={visibleTabs} />
            <UsageReports report={activeReport} range={range} subTab={nav.sub} nonce={nav.nonce} onOpenTab={openTab} />
        </div>
    );
};

export default UsageSection;
