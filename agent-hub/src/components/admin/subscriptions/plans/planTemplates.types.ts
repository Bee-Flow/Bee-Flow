import type { PlanRecord } from './usePlanForm';

/** One entry of the "+ From Template" gallery: how it is shown, and the plan payload it seeds. */
export interface PlanTemplate {
    id: string;
    audience: 'organization' | 'consumer';
    display: {
        title: string;
        subtitle: string;
        priceLabel: string;
        highlights?: string[];
        badge?: string;
    };
    plan: PlanRecord;
}
