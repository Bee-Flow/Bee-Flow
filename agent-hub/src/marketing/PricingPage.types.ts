export interface Plan {
    id: string;
    planType: string;
    name: string;
    price: number | string | null;
    currency: string;
    billingInterval: string;
    maxUsers: number | null;
    maxAgents: number | null;
    maxMessagesPerMonth: number | null;
    maxKnowledgeSources: number | null;
    allowedFeatures?: string[];
    ncRecommended?: boolean;
    isDefault?: boolean;
    tagline?: string;
    trialDays: number;
    description?: string;
}
