
/** The ids of the "when" presets the composer offers. */
export type WhenPresetId = 'now' | 'in_1h' | 'tonight' | 'tomorrow' | 'next_week' | 'custom';

export type WhenPreset = {
    id: WhenPresetId;
    labelKey: string;
    label: string;
} & ({ hintKey: string; hint: string } | { hintKey?: undefined; hint: string | null });

export interface RepeatOption {
    value: string;
    labelKey: string;
    label: string;
}

/** The composer's chosen moment: a preset, plus the date and time for `custom`. */
export interface WhenState {
    presetId: WhenPresetId;
    date: string;
    time: string;
}

/** Mail apps an agent can be started by: `gmail` (Gmail) and `msgraph` (Outlook). */
export type MailProvider = 'gmail' | 'msgraph';

/** The optional narrowing of a "new email" trigger; the same shape the automation app-event trigger uses. */
export interface MailTriggerFilter {
    from?: string;
    subjectContains?: string;
    labelIds?: string[];
    hasAttachment?: boolean;
    excludeFromSelf?: boolean;
    /** Outlook only: 'me' or absent = the own inbox, otherwise a shared mailbox address. */
    mailbox?: string;
}

/** What starts a cowork item that is not on a clock: a new email. */
export interface MailTrigger {
    provider: MailProvider;
    event: 'mail.new';
    filter?: MailTriggerFilter;
}

/** One cowork item (a schedule row) as GET /api/cowork returns it. */
export interface CoworkItem {
    id: string;
    /** What it may spend on AI in a month, in euros; null: no limit (server/core/cowork/runBudget.mts). */
    monthlyBudget?: number | null;
    title: string;
    prompt: string;
    isActive?: boolean;
    repeatInterval?: string | null;
    timeOfDay?: string | null;
    daysOfWeek?: string[] | null;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastStatus?: string | null;
    runCount: number;
    currentRunStartedAt?: string | null;
    agentId?: string | null;
    modelTier?: string | null;
    enabledApps?: string[] | null;
    triggerKind?: 'schedule' | 'app_event';
    trigger?: MailTrigger | null;
    /** Runs that asked for review and wait for the owner (absent from an older server: read as 0). */
    openReviewCount?: number;
    /** The automation its plan is made from; null without a plan. Its approvals are found by it. */
    planAutomationId?: string | null;
}

/** How the owner handled a run that asked for review. */
type CoworkReviewResolution = 'answered' | 'done_myself' | 'not_needed';

/** What the agent asked for (cowork_request_review), and how its owner handled it. */
interface CoworkRunReview {
    reason: string;
    question: string | null;
    summary: string | null;
    resolution: CoworkReviewResolution | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
}

/** One tool a run called: its name and app, and how its calls ended (a refusal with its reason codes). */
export interface CoworkRunTool {
    name: string;
    app: string | null;
    ok: number;
    failed: number;
    refused: number;
    reasons: string[];
    /** What a person calls it ("Outlook: create draft"); null or absent when nobody named it (server usecases/coworkRunWords.mts). */
    label?: string | null;
    /** What it does to the world; absent from an older server. */
    effect?: 'reads' | 'writes' | 'sends';
    /** One of Cowork's own tools (asking for a review, giving its verdict): no step of the work. */
    internal?: boolean;
}

/** What one run did, in names and counts only. */
interface CoworkRunActivity {
    tools: CoworkRunTool[];
    skills: Array<{ id: string; name: string; how: 'static' | 'activated' }>;
    toolCalls: number;
    /** The run read text written outside the workspace; from then on it sent nothing to other people. */
    readOutsideText?: boolean;
}

/** One execution of a cowork item. */
export interface CoworkRun {
    id: string;
    status: string;
    startedAt: string;
    durationMs?: number | null;
    /** The raw reason a run stopped; shown only under "Technical details". */
    error?: string | null;
    /** What happened, in the reader's own words (server usecases/coworkRunWords.mts); null or absent when the server has none. */
    plain?: string | null;
    result?: string | null;
    producedOutput?: boolean | null;
    triggerKind?: string;
    /** The conversation the run wrote into (an agent run). */
    conversationId?: string | null;
    /** A follow-up after an answered review: the run it continues. */
    parentRunId?: string | null;
    followupDepth?: number;
    /** The subject of the e-mail that started a mail run. */
    mailSubject?: string | null;
    review?: CoworkRunReview | null;
    /** Null for a run from before this was kept. */
    activity?: CoworkRunActivity | null;
    /** What the run cost in AI; null when it made no priced call or the cost could not be read. */
    cost?: CoworkCost | null;
    /** The approved plan this run followed; null or absent for a prompt or agent run. */
    planId?: string | null;
    /** Where a plan run failed: the step, its error class and the step it reads (ids and a code; server core/cowork/runOutcome.mts). */
    failure?: CoworkRunFailure;
}

/** The step a plan run failed at, in ids and a code. */
export interface CoworkRunFailure {
    stepId: string;
    errorClass: string | null;
    /** The step whose output it reads; null for the start of the run or none. */
    sourceStepId: string | null;
}

/** How the owner handles a run that waits for review. */
export type CoworkReviewAction = 'answer' | 'done_myself' | 'not_needed';

/** An AI cost: per currency, and how many model calls it was. */
interface CoworkCost {
    byCurrency: Record<string, number>;
    calls: number;
}

export interface CoworkStatsData {
    total: number;
    success: number;
    failed: number;
    avgDurationMs: number | null;
    runCount: number;
    createdAt: string | null;
    /** This item's AI cost this calendar month; null when it could not be read. */
    costThisMonth?: CoworkCost | null;
}

/** An agent the work can be handed to. */
export interface CoworkAgent {
    id: string;
    name?: string;
    description?: string;
}

/** What POST /api/cowork/compose answers; every field may be missing. */
export interface CoworkSpec {
    title?: string;
    prompt?: string;
    repeatInterval?: string;
    agentId?: string;
    daysOfWeek?: string[];
    timeOfDay?: string;
}

/** The body buildCoworkPayload produces for POST /api/cowork. */
export interface CoworkPayload {
    title: string;
    prompt: string;
    nextRunAt: string;
    repeatInterval: string | null;
    modelTier: string;
    timezone: string;
    daysOfWeek?: string[];
    timeOfDay?: string;
    agentId?: string;
    enabledApps?: string[];
    startNow?: true;
}

/** The POST /api/cowork body of an agent that starts on a new email: no clock, so no `nextRunAt`. */
export interface CoworkTriggerPayload {
    title: string;
    prompt: string;
    repeatInterval: null;
    modelTier: string;
    timezone: string;
    agentId: string;
    triggerKind: 'app_event';
    trigger: MailTrigger;
    enabledApps?: string[];
    startNow?: undefined;
}

/** The body the edit form sends to PUT /api/cowork/:id. */
export interface CoworkUpdate {
    title: string;
    prompt: string;
    /** The clock fields are left out for a mail-trigger item. */
    repeatInterval?: string | null;
    daysOfWeek?: string[] | null;
    nextRunAt?: string | null | undefined;
    timeOfDay?: string | null;
    agentId: string | null;
    enabledApps: string[] | null;
    triggerKind?: 'app_event';
    trigger?: MailTrigger;
    /** Euros a month on AI; null: no limit. */
    monthlyBudget?: number | null;
}

/** The signed-in user as the Cowork page reads it: simple mode, and who administers what (utils/adminAccess.ts). */
export type CoworkViewer = {
    simpleMode?: boolean;
    id?: string;
    isAdmin?: boolean | null;
    role?: string | null;
    orgRole?: string | null;
    organizationId?: string | null;
    isHomeOrgAdmin?: boolean;
};

/** The props of the Cowork page. */
export interface CoworkPageProps {
    user?: CoworkViewer | null;
    isMobile?: boolean;
    initialCoworkId?: string | null;
    onNavigate?: (path: string) => void;
}
