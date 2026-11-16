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
        /**
         * Operator-only note (economics, markup, sizing). Shown in the template
         * gallery only; never copied into `plan`, so it never reaches a customer.
         */
        operatorNote?: string;
    };
    plan: PlanRecord;
}
