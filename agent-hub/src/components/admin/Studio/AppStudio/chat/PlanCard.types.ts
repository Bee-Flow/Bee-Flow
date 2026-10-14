/** A row the model emitted as an object: its own keys, plus the client-only id under a symbol key. */
export interface PlanObject {
    [key: string]: unknown;
    [key: symbol]: unknown;
}

/** A plan row: a bare string, or an object carrying its fields. */
export type PlanRow = string | PlanObject;

/** The lists the plan edits in place. */
export type ListField = 'screens' | 'roles' | 'datasets' | 'tables';

/** The editable draft of the plan artifact. */
export interface PlanDraft {
    [key: string]: unknown;
    title: string;
    summary: string;
    tables: PlanRow[];
    roles: PlanRow[];
    datasets: PlanRow[];
    screens: PlanRow[];
    openQuestions: unknown[];
}

export interface PlanCardProps {
    pendingPlan?: { planId?: string | null; plan?: unknown } | null;
    onBuild?: (plan: PlanDraft) => void;
    onDiscuss?: () => void;
    disabled?: boolean;
}
