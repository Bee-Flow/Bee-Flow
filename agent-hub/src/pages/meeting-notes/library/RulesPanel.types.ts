import type { TranslateFn } from '../../../hooks/useTranslation';
import type { AutomationApiError } from '../../../hooks/useAutomationApi';

export type { TranslateFn };
import type { consequencesOf, triggerConditionOf } from '../lib/meetingRules';

export type TriggerCondition = ReturnType<typeof triggerConditionOf>;
export type Consequences = ReturnType<typeof consequencesOf>;

/** An automation row as GET /api/automation lists it (the fields this panel reads). */
export interface RuleRow {
    id: string;
    title?: string;
    isActive?: boolean;
    isDraft?: boolean;
    definition?: unknown;
}

/** An Error from the automation API, possibly carrying the server's code/status. */
export type RuleError = AutomationApiError;

/** One idea from the suggestion scan. */
export interface RuleIdea {
    id?: string;
    title?: string;
    description?: string;
}

export interface SuggestDone {
    suggestions?: RuleIdea[];
    reason?: string | null;
}

export interface RulesState {
    loading: boolean;
    error: RuleError | null;
    rows: RuleRow[] | null;
}

export interface RunFacets {
    automationId?: Record<string, unknown>;
}

export interface RunsState {
    loading: boolean;
    error: RuleError | null;
    facets: RunFacets | null;
    hours: number;
}

export interface RunFacetsBody {
    rangeHours?: number;
    facets?: RunFacets | null;
}

export interface IdeasState {
    busy: boolean;
    ran: boolean;
    error: string | null;
    reason: string | null;
    items: RuleIdea[];
}

export interface CreatedAutomation {
    automation?: { id?: string };
    id?: string;
}

export interface RunLabelInput {
    facets: RunFacets | null;
    facetsError: boolean;
    automationId: string | undefined;
    hours: number;
}

export interface RuleFooterProps {
    row: RuleRow;
    runs: string | null;
    open: string;
    onOpen?: ((id: string) => void) | null;
    t: TranslateFn;
}

export interface RuleCardProps {
    row: RuleRow;
    facets: RunFacets | null;
    facetsError: boolean;
    hours: number;
    currentUserId?: string | null;
    onOpen?: ((id: string) => void) | null;
    t: TranslateFn;
}

export interface ComposerProps {
    text: string;
    onText: (text: string) => void;
    ideas: IdeasState;
    onRun: () => void;
    onUseIdea: (idea: RuleIdea) => void;
    creating: boolean;
    t: TranslateFn;
}

export interface RulesPanelProps {
    currentUserId?: string | null;
    onNavigate?: ((href: string) => void) | null;
    onComposeRule?: ((message: string, suggestion: RuleIdea) => void) | null;
    onRulesChange?: ((count: number | null) => void) | null;
}
