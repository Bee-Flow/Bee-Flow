import { useCallback, useState } from 'react';

/** The plan editor's working copy of a plan. */
export interface PlanForm {
    name: string;
    description: string;
    max_cost_per_month: number | null;
    max_users: number | null;
    max_agents: number | null;
    max_knowledge_sources: number | null;
    allowed_features: string[];
    allowed_models: string[];
    allowed_integrations: string[] | null;
    allowed_beta_features: string[] | null;
    billing_model: string;
    markup_percent: number;
    is_default: boolean;
    price: number | null;
    currency: string;
    billing_interval: string;
    trial_days: number;
    sort_order: number;
    is_public: boolean;
    plan_type: string;
    nc_recommended: boolean;
    nc_only: boolean;
    tagline: string;
    per_seat: boolean;
}

/** Set one field of the working copy. */
export type UpdatePlanField = (key: keyof PlanForm, val: PlanForm[keyof PlanForm]) => void;

/** A plan as the server or a template sends it: every field may be missing or null. */
export type PlanInput = { [K in keyof PlanForm]?: PlanForm[K] | null } & { tier?: string | null };

export function initPlanForm(plan: PlanInput | null | undefined): PlanForm {
    return {
        name: plan?.name || '',
        description: plan?.description || '',
        max_cost_per_month:     plan?.max_cost_per_month     ?? null,
        max_users:              plan?.max_users              ?? null,
        max_agents:             plan?.max_agents             ?? null,
        max_knowledge_sources:  plan?.max_knowledge_sources  ?? null,
        allowed_features:       plan?.allowed_features       || [],
        allowed_models:         plan?.allowed_models         || [],
        // tri-state — undefined → null (unrestricted) so existing legacy plans keep their broad behavior.
        // MCP servers (mcp:<id>) live inside allowed_integrations now (opt-in; only count when explicit).
        allowed_integrations:   plan?.allowed_integrations === undefined ? null : plan.allowed_integrations,
        allowed_beta_features:  plan?.allowed_beta_features === undefined ? null : plan.allowed_beta_features,
        billing_model:          plan?.billing_model          || 'fixed',
        markup_percent:         plan?.markup_percent         ?? 20,
        is_default:             plan?.is_default             || false,
        price:                  plan?.price                  ?? null,
        currency:               plan?.currency               || 'EUR',
        billing_interval:       plan?.billing_interval       || 'monthly',
        trial_days:             plan?.trial_days             ?? 0,
        sort_order:             plan?.sort_order             ?? 0,
        is_public:              plan?.is_public              || false,
        plan_type:              plan?.plan_type              || 'organization',
        nc_recommended:         plan?.nc_recommended         || false,
        nc_only:                plan?.nc_only                || false,
        tagline:                plan?.tagline                || '',
        per_seat:               plan?.per_seat               || false,
    };
}

export function usePlanForm(plan: PlanInput | null | undefined) {
    const [form, setForm] = useState<PlanForm>(() => initPlanForm(plan));

    const update: UpdatePlanField = useCallback((key: keyof PlanForm, val: PlanForm[keyof PlanForm]) => {
        setForm(prev => ({ ...prev, [key]: val }));
    }, []);

    const valid = !!form.name.trim();

    return { form, setForm, update, valid };
}
