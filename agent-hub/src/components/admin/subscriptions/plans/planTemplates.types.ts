import type { PlanInput } from './usePlanForm';

/** What the gallery shows for one template. */
export interface PlanTemplateDisplay {
    title: string;
    subtitle: string;
    priceLabel: string;
    highlights?: string[];
    badge?: string;
}

/** One curated template: its audience, its card, and the editor payload it seeds. */
export interface PlanTemplate {
    id: string;
    audience: 'organization' | 'consumer';
    display: PlanTemplateDisplay;
    plan: PlanInput;
}
