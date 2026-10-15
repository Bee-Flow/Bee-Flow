import type { HasFeature, LessonGate, LessonUser } from './lessons.types';

export interface CheckContext {
    user?: LessonUser | null;
    hasFeature?: HasFeature;
}

export interface CriterionExpect {
    kind?: string;
    field?: string;
    value?: unknown;
}

export interface CheckCriterion {
    id: string;
    labelKey?: string;
    labelFallback: string;
    hintKey?: string;
    hintFallback?: string;
    optional?: boolean;
    gate?: LessonGate;
    unverifiable?: boolean;
}

/** A criterion as declared by a generated lesson check: it names an endpoint and what to expect from it. */
export interface CriterionSpec extends CheckCriterion {
    endpoint?: string;
    expect?: CriterionExpect;
}

export type CheckVerdict = Record<string, boolean>;

/** The data bag an evaluator reads; which keys are present depends on the check. */
export interface CheckData {
    automations?: AutomationRow[];
    runs?: unknown[];
    schedules?: CoworkRow[];
    agents?: AgentRow[];
    kbs?: KbRow[];
    userId?: string | null;
    __bodies?: Record<string, unknown>;
}

export interface AutomationRow {
    triggerType?: string;
    definition?: { trigger?: { type?: string } };
    lastRunAt?: string | null;
}

export interface CoworkRow {
    lastRunAt?: string | null;
    last_run_at?: string | null;
    runCount?: number;
    run_count?: number;
}

export interface AgentRow {
    owner_id?: string;
    ownerId?: string;
    is_published?: boolean;
    isPublished?: boolean;
}

export interface KbRow {
    source_kind?: string;
    sourceKind?: string;
    tenant_id?: string;
    tenantId?: string;
    document_count?: number | string;
    documentCount?: number | string;
}

export interface ActionCheck {
    criteria: CheckCriterion[];
    fetchState(ctx: CheckContext): Promise<CheckData>;
    evaluate(data: CheckData): CheckVerdict;
}

export interface ActionCheckResult {
    passes: CheckVerdict;
    allPassed: boolean;
    error: string | null;
    unverifiable: string[];
}
