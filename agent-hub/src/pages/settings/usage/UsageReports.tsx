import { useCallback, useMemo, type ComponentProps } from 'react';
import { useUsageSubscription, useUsageTiers } from '@/api/queries/settingsUsage';
import type { StarterModel } from '@/api/runtimeTypes';
import { buildModelTierMap, deriveRangeParams, tierForModel } from '@/utils/usageHelpers';
import { currencySym } from './format';
import OverviewTab from './OverviewTab';
import AdoptionTab from './adoption/AdoptionTab';
import QualityTab from './quality/QualityTab';
import SpendTab from './spend/SpendTab';
import type { UsageRange } from './RangeControl';
import { UsageFilterBar } from './UsageFilterBar';
import { useUsageFilters } from './useUsageFilters';
import { useUsageReportData } from './useUsageReportData';

type StarterTiers = { fast?: StarterModel; standard?: StarterModel; thinking?: StarterModel };
const EMPTY_TIER_MAP: Record<string, string> = {};

export interface UsageReportsProps {
    /** Which report: overview, adoption, spend or quality. */
    report: string;
    /** The period, one object for as long as it does not change. */
    range: UsageRange;
    /** Sub-tab to open first. `nonce` remounts the report so a new deep link re-seeds it. */
    subTab?: string;
    nonce?: number;
    onOpenTab: (tab: string, subTab?: string) => void;
    /** The organisation the reads cover (a platform admin's choice); none: the caller's own. */
    orgId?: string | null;
    /** The figures cover every organisation, so the organisation-specific parts (subscription, adoption) are left out. */
    allOrganisations?: boolean;
}

/** The model-to-tier lookups of the badges and the "By tier" breakdown. */
function useTierLookups() {
    // Raw tiers config retained so the customer "By tier" breakdown can resolve
    // custom-tier display labels (tierLabel needs the tier object for `custom:*`).
    const tiersRaw = useUsageTiers<Parameters<typeof buildModelTierMap>[0]>().data;
    const modelTierMap = useMemo(() => (tiersRaw ? buildModelTierMap(tiersRaw) : EMPTY_TIER_MAP), [tiersRaw]);
    const modelTiers: StarterTiers = useMemo(
        () => (tiersRaw && typeof tiersRaw === 'object' ? tiersRaw as StarterTiers : {}), [tiersRaw]);
    const tierFor = useCallback((model: string | null) => tierForModel(modelTierMap, model), [modelTierMap]);
    return { modelTiers, tierFor };
}

type UsageProps = ComponentProps<typeof OverviewTab>;

interface ReportBodyProps extends Pick<UsageReportsProps, 'report' | 'range' | 'subTab' | 'orgId' | 'allOrganisations'> {
    usageProps: UsageProps;
    nonce: number;
    currency: string;
    showTokens: boolean;
    /** The call count the quality share is taken against; none while a filter narrows the usage figures. */
    totalCalls: number | undefined;
}

/** The report that is open. */
function ReportBody({ report, usageProps, range, subTab, nonce, orgId, allOrganisations, currency, showTokens, totalCalls }: ReportBodyProps) {
    const { rangeParams } = usageProps;
    if (report === 'overview') return <OverviewTab {...usageProps} />;
    if (report === 'spend') return <SpendTab {...usageProps} key={nonce} initialSubTab={subTab} orgId={orgId} allOrganisations={allOrganisations} />;
    if (report === 'adoption') {
        return <AdoptionTab key={nonce} rangeParams={rangeParams} rangePreset={range.preset} showTokens={showTokens} currency={currency} initialSubTab={subTab} orgId={orgId} />;
    }
    // The feedback and termination counts are org-wide; a filtered call count would skew their share.
    if (report === 'quality') return <QualityTab key={nonce} rangeParams={rangeParams} showTokens={showTokens} initialSubTab={subTab} totalCalls={totalCalls} />;
    return null;
}

/** The usage reports (Overview, Adoption, Spend, Quality) with their data, the shared filter bar and the organisation they cover. */
export default function UsageReports({ report, range, subTab, nonce = 0, onOpenTab, orgId = null, allOrganisations = false }: UsageReportsProps) {
    const rangeParams = useMemo(() => deriveRangeParams(range), [range]);
    const filters = useUsageFilters();
    const { data, azureServices, loading, isCustomerView, showTokens } = useUsageReportData(rangeParams, filters, orgId);
    const subscription = useUsageSubscription(orgId, !allOrganisations).data ?? null;
    const { modelTiers, tierFor } = useTierLookups();
    // Adoption and Quality read their own endpoints: the cross-cutting
    // filters and the usage skeleton only apply to Overview and Spend.
    const isUsageTab = report === 'overview' || report === 'spend';
    const billing = (subscription as { billing?: { plan_currency?: string } | null } | null)?.billing;
    const usageProps = {
        data, subscription, isCustomerView, showTokens, tierForModel: tierFor, modelTiers, azureServices,
        setFilterUser: filters.setUser, setFilterModel: filters.setModel, setFilterSource: filters.setSource, onOpenTab,
        rangeParams, rangePreset: range.preset, hasFilters: filters.active,
    };

    return (
        <div className="flex flex-col gap-4">
            {isUsageTab && <UsageFilterBar filters={filters} data={data} isCustomerView={isCustomerView} />}
            {loading && isUsageTab ? (
                <div className="[display:flex] [flex-direction:column] [gap:12px]">
                    <div className="[display:grid] [grid-template-columns:repeat(4,1fr)] [gap:10px]">
                        {[1, 2, 3, 4].map(i => <div key={i} className="h-[80px] [border-radius:12px] [background:var(--bg-tertiary)] [animation:pulse_1.5s_ease-in-out_infinite]" />)}
                    </div>
                    <div className="h-[90px] [border-radius:12px] [background:var(--bg-tertiary)] [animation:pulse_1.5s_ease-in-out_infinite]" />
                </div>
            ) : (
                <ReportBody report={report} usageProps={usageProps} range={range} subTab={subTab} nonce={nonce} orgId={orgId} allOrganisations={allOrganisations} currency={currencySym(billing?.plan_currency || 'EUR')} totalCalls={filters.active ? undefined : data.summary?.total_calls} showTokens={showTokens} />
            )}
        </div>
    );
}
