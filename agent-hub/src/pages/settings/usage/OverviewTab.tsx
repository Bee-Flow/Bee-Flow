// Overview tab of Usage & Monitoring: the one-minute read.
//
// Four numbers with their change since the previous period, a card with what
// needs attention (only when something does), the weekly spend per area, and
// two short lists that each end in a link to the tab that holds the rest.
// Adoption figures come from the adoption reads and only exist with the
// `advanced_usage_monitoring` licence feature; without it the tiles that need
// them are left out. Depth lives in the Adoption and Spend tabs.

import { useLicenseContext } from '@/components/licensing/LicenseContext';
import { useTranslation } from '@/hooks/useTranslation';
import { currencySym } from './format';
import { AdoptionGate, type OverviewAdoption } from './overview/adoptionData';
import { AreasList } from './overview/AreasList';
import { AttentionCard } from './overview/AttentionCard';
import { attentionRows } from './overview/attention';
import { KpiRow } from './overview/KpiRow';
import { TopModels } from './overview/TopModels';
import { WeeklyAreaChart } from './overview/WeeklyAreaChart';
import type { ModelRow, OverviewTabProps, SubscriptionInfo } from './OverviewTab.types';

const NOOP = () => {};

type BodyProps = OverviewTabProps & { adoption: OverviewAdoption | null };

function OverviewBody({ data, subscription, isCustomerView, showTokens, compare = true, hasFilters = false, onOpenTab = NOOP, adoption }: BodyProps) {
    const { t } = useTranslation();
    const currency = currencySym((subscription as SubscriptionInfo | null)?.billing?.plan_currency || 'EUR');
    const models = (data.models || []) as ModelRow[];
    // The adoption figures are org-wide: a member/agent/model/source filter makes them incomparable with the usage figures.
    const showDelta = compare && !hasFilters;
    const rows = attentionRows({ adoption, models, isCustomerView, currency, t });
    const showCalls = showTokens && !isCustomerView;
    return (
        <div className="flex flex-col gap-5">
            <KpiRow data={data} adoption={adoption} isCustomerView={isCustomerView} showTokens={showTokens} currency={currency} showDelta={showDelta} onOpenTab={onOpenTab} />
            <AttentionCard rows={rows} onOpenTab={onOpenTab} />
            {adoption?.areas && <WeeklyAreaChart areas={adoption.areas} currency={currency} onTableView={() => onOpenTab('spend')} />}
            <section className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr))]">
                {adoption?.areas && <AreasList areas={adoption.areas} currency={currency} showCalls={showCalls} onOpenAdoption={() => onOpenTab('adoption', 'areas')} />}
                {!isCustomerView && <TopModels models={models} currency={currency} onOpenSpend={() => onOpenTab('spend', 'models')} />}
            </section>
            <p className="m-0 text-xs text-[var(--text-muted)]">
                {t('usage.ov_footnote', 'Costs are estimates at list price. Documents and Datatables are not metered yet; their AI use is not in these figures.')}
            </p>
        </div>
    );
}

export default function OverviewTab(props: OverviewTabProps) {
    const { hasFeature } = useLicenseContext();
    return (
        <AdoptionGate enabled={hasFeature('advanced_usage_monitoring')} rangeParams={props.rangeParams} rangePreset={props.rangePreset}>
            {adoption => <OverviewBody {...props} adoption={adoption} />}
        </AdoptionGate>
    );
}
