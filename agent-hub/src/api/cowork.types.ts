
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
}

/** One execution of a cowork item. */
export interface CoworkRun {
    id: string;
    status: string;
    startedAt: string;
    durationMs?: number | null;
    error?: string | null;
    result?: string | null;
    producedOutput?: boolean | null;
    triggerKind?: string;
}

export interface CoworkStatsData {
    total: number;
    success: number;
    failed: number;
    avgDurationMs: number | null;
    runCount: number;
    createdAt: string | null;
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
}

/** The props of the Cowork page. */
export interface CoworkPageProps {
    user?: { simpleMode?: boolean; id?: string } | null;
    isMobile?: boolean;
    initialCoworkId?: string | null;
    onNavigate?: (path: string) => void;
}
