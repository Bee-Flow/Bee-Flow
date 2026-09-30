/** Cowork shapes, from server/stores/coworkStore.js and routes/cowork.js. */

/** Mirrors `rowToSchedule` in server/stores/coworkStore.js. */
export interface CoworkSchedule {
    id: string;
    userId: string;
    title: string;
    prompt: string;
    repeatInterval: string | null;
    daysOfWeek: string[] | null;
    timeOfDay: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastResult: string | null;
    lastStatus: string | null;
    isActive: boolean;
    modelTier: string | null;
    runCount: number;
    timezone: string | null;
    agentId: string | null;
    conversationId: string | null;
    createdAt: string | null;
}

/** One entry of a schedule's history — `rowToRun` in coworkStore.js. */
export interface CoworkRun {
    id?: string;
    status?: string;
    result?: string | null;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    createdAt?: string | null;
}

/**
 * What the AI composer returns from a plain-language brief. Note what is NOT
 * here: `nextRunAt`. The composer is read-only and returns a shape, not a
 * schedule — turning "every Monday morning" into an instant is the client's
 * job (see schedule.ts), and POST /api/cowork 400s without it.
 */
export interface ComposedCowork {
    title?: string;
    prompt?: string;
    repeatInterval?: string | null;
    daysOfWeek?: string[] | null;
    timeOfDay?: string | null;
    runOnce?: boolean;
    agentId?: string | null;
}
