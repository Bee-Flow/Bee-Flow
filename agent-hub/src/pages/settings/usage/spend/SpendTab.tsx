// Spend tab of Usage & Monitoring: where the money goes.
//
// A hero with the period's cost, its change, the monthly budget and the cost
// per day, then one table per question under sub-tabs: models, people, agents,
// sources and the AI services billed outside the model table. The cloud
// customer view (no tokens, billed cost, tiers instead of models) keeps its
// own page: see CustomerSpend.

import { useState } from 'react';
import { useLicenseContext } from '@/components/licensing/LicenseContext';
import { OVERVIEW_COST_ALERT } from '@/config/analyticsConfig';
import { useTranslation } from '@/hooks/useTranslation';
import { AlertBanner } from '../kit';
import { currencySym, formatDateRange } from '../format';
import { fMoney } from '../adoption/format';
import { SubTabs } from '../shell';
import { SummaryGate } from '../overview/adoptionData';
import type { OverviewTabProps, SubscriptionInfo } from '../OverviewTab.types';
import { AgentsTable } from './AgentsTable';
import { ByTierCard } from './ByTierCard';
import { CustomerSpend } from './CustomerSpend';
import { ModelsTable } from './ModelsTable';
import { OtherServicesPanel } from './OtherServicesPanel';
import { PeopleTable } from './PeopleTable';
import { SourcesTable } from './SourcesTable';
import { SpendHero } from './SpendHero';
import { headlineCost, pctChange } from './spendFormat';

export type SpendSubTab = 'models' | 'people' | 'agents' | 'sources' | 'services';
const SUB_TABS: SpendSubTab[] = ['models', 'people', 'agents', 'sources', 'services'];

export interface SpendTabProps extends OverviewTabProps {
    /** Sub-tab to open first. */
    initialSubTab?: string;
}

function isSubTab(id: string | undefined): id is SpendSubTab {
    return SUB_TABS.includes(id as SpendSubTab);
}

function SpendBody(props: SpendTabProps & { deltaPct: number | null }) {
    const { t } = useTranslation();
    const { data, subscription, showTokens, azureServices, compare = true, hasFilters = false, rangeParams, deltaPct, initialSubTab } = props;
    const [sub, setSub] = useState<SpendSubTab>(isSubTab(initialSubTab) ? initialSubTab : 'models');
    const currency = currencySym((subscription as SubscriptionInfo | null)?.billing?.plan_currency || 'EUR');
    const cost = headlineCost(data.summary, false);
    const overBudget = cost > OVERVIEW_COST_ALERT;
    const view = { data, azureServices, showTokens, tierForModel: props.tierForModel, modelTiers: props.modelTiers, setFilterUser: props.setFilterUser, setFilterModel: props.setFilterModel, setFilterSource: props.setFilterSource, currency };
    const labels: Record<SpendSubTab, string> = {
        models: t('usage.spend_tab_models', 'Models'),
        people: t('usage.spend_tab_people', 'People'),
        agents: t('usage.spend_tab_agents', 'Agents'),
        sources: t('usage.spend_tab_sources', 'Sources'),
        services: t('usage.spend_tab_services', 'Other services'),
    };
    const descriptions: Record<SpendSubTab, string> = {
        models: t('usage.spend_desc_models', 'Models: what each model cost, and who and what drove it.'),
        people: t('usage.spend_desc_people', 'People: what each member cost and which models they used.'),
        agents: t('usage.spend_desc_agents', 'Agents: which agents drive the usage, and the models behind them.'),
        sources: t('usage.spend_desc_sources', 'Sources: where in the product the usage came from.'),
        services: t('usage.spend_desc_services', 'Other services: AI services billed outside the model table.'),
    };
    return (
        <div className="flex flex-col gap-5">
            {overBudget && (
                <AlertBanner
                    severity={cost > OVERVIEW_COST_ALERT * 2 ? 'red' : 'amber'}
                    title={t('usage.overview.spend_over_budget', 'Spend over budget')}
                    message={t('usage.overview.spend_over_budget_msg', '{cost} spent this period — threshold {threshold}.', { cost: fMoney(cost, currency), threshold: fMoney(OVERVIEW_COST_ALERT, currency) })}
                    ctaLabel={t('usage.overview.review_by_model', 'Review by model')}
                    onCta={() => setSub('models')}
                />
            )}
            <SpendHero
                data={data} subscription={subscription} showTokens={showTokens} currency={currency}
                rangeLabel={formatDateRange(rangeParams.startDate, rangeParams.endDate)}
                deltaPct={deltaPct} showDelta={compare && !hasFilters} days={rangeParams.days}
            />
            <SubTabs
                value={sub} onChange={id => setSub(id as SpendSubTab)} aria-label={t('usage.spend_views', 'Spend views')}
                options={SUB_TABS.map(id => ({ id, label: labels[id] }))} description={descriptions[sub]}
            />
            {sub === 'models' && (
                <>
                    <ModelsTable {...view} />
                    <section className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
                        <ByTierCard {...view} />
                    </section>
                </>
            )}
            {sub === 'people' && <PeopleTable {...view} />}
            {sub === 'agents' && <AgentsTable {...view} />}
            {sub === 'sources' && <SourcesTable {...view} />}
            {sub === 'services' && <OtherServicesPanel azureServices={azureServices} currency={currency} showTokens={showTokens} />}
            <p className="m-0 text-xs text-[var(--text-muted)]">
                {t('usage.spend_footnote', 'Costs are estimates at list price. Self-hosted models are priced at zero; a model without a name on the call cannot be priced and is listed as "unknown".')}
            </p>
        </div>
    );
}

export default function SpendTab(props: SpendTabProps) {
    const { hasFeature } = useLicenseContext();
    if (props.isCustomerView) {
        return <CustomerSpend data={props.data} subscription={props.subscription} tierForModel={props.tierForModel} modelTiers={props.modelTiers} />;
    }
    return (
        <SummaryGate enabled={hasFeature('advanced_usage_monitoring')} rangeParams={props.rangeParams} rangePreset={props.rangePreset}>
            {(summary) => (
                <SpendBody {...props} deltaPct={summary ? pctChange(summary.spend.cost, summary.prev?.cost) : null} />
            )}
        </SummaryGate>
    );
}
