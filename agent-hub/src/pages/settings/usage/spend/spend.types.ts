import type { OverviewTabProps } from '../OverviewTab.types';

/** What every Spend view reads: the usage report, the filter setters and the currency symbol. */
export type SpendViewProps = Pick<OverviewTabProps,
    'data' | 'azureServices' | 'showTokens' | 'tierForModel' | 'modelTiers' | 'setFilterUser' | 'setFilterModel' | 'setFilterSource'
> & {
    currency: string;
};
