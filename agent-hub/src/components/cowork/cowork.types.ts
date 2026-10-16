
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

/** The body the edit form sends to PUT /api/cowork/:id. */
export interface CoworkUpdate {
    title: string;
    prompt: string;
    repeatInterval: string | null;
    daysOfWeek: string[] | null;
    nextRunAt: string | null | undefined;
    timeOfDay: string | null;
    agentId: string | null;
    enabledApps: string[] | null;
}

/** The props of the Cowork page. */
export interface CoworkPageProps {
    user?: { simpleMode?: boolean } | null;
    isMobile?: boolean;
    initialCoworkId?: string | null;
    onNavigate?: (path: string) => void;
}
