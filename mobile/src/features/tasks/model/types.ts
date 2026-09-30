/**
 * AI tasks ("routines") and reminders, from the server's own row mappers:
 * server/stores/aiTaskStore.js rowToTask() and server/stores/reminderStore.js
 * getReminders(). Both answer camelCase.
 */

/** The intervals routes/aiTasks.js accepts. `null` is a one-off. */
export const REPEAT_INTERVALS = [
    'hourly',
    'daily',
    'weekdays',
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'yearly',
] as const;
export type RepeatInterval = (typeof REPEAT_INTERVALS)[number];

export interface AiTask {
    id: string;
    userId: string;
    title: string;
    prompt: string;
    repeatInterval: RepeatInterval | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastResult: string | null;
    lastStatus: string | null;
    isActive: boolean;
    modelTier: string | null;
    runCount: number | null;
    timezone: string | null;
    createdAt: string | null;
    agentId: string | null;
    conversationId: string | null;
    daysOfWeek: string[] | null;
    timeOfDay: string | null;
    /** Joined in by routes/aiTasks.js for agent-scoped routines only. */
    agentName?: string;
    agentAvatar?: string;
}

export interface AiTaskList {
    tasks: AiTask[];
    /** Admin-configurable cap; the create button has to respect it. */
    maxTasks: number;
}

export interface Reminder {
    id: string;
    userId: string;
    title: string;
    message: string | null;
    remindAt: string | null;
    repeatInterval: string | null;
    isCompleted: boolean;
    createdAt: string | null;
}
