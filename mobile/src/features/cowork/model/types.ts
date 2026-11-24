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
    /** What the run asked its owner, and how it was handled; null for a run that asked nothing. */
    review?: CoworkReview | null;
}

/** `reviewOf` in server/stores/coworkRows.js: the question a run stopped at. */
export interface CoworkReview {
    reason: string | null;
    question: string | null;
    summary: string | null;
    /** answered, done_myself or not_needed once the owner handled it; null while it waits. */
    resolution: string | null;
}

/** The three ways the owner handles a waiting review (POST /api/cowork/:id/runs/:runId/review). */
export type ReviewAction = 'answer' | 'done_myself' | 'not_needed';

export type SharedRole = 'viewer' | 'approver';

/** One entry of GET /api/cowork/shared: someone else's Cowork work that is shared with the caller. */
export interface SharedItem {
    id: string;
    ownerId: string;
    ownerName: string;
    title: string;
    role: SharedRole;
    lastStatus: string | null;
    lastRunAt: string | null;
    isActive: boolean;
}

/** GET /api/cowork/shared/:id (`sharedItemOf` in server/usecases/coworkShares.mts): read only. */
export interface SharedView {
    role: SharedRole | 'owner';
    item: {
        id: string;
        title: string;
        prompt: string;
        repeatInterval: string | null;
        nextRunAt: string | null;
        lastStatus: string | null;
        isActive: boolean;
        triggerKind: string;
    };
    runs: SharedRun[];
}

export interface SharedRun {
    id: string;
    status: string | null;
    startedAt: string | null;
    result: string | null;
    durationMs: number | null;
}

/** GET /api/cowork/:id/runs/:runId/receipt (`ReceiptLine` in server/usecases/coworkReceipts.mts). */
export interface CoworkReceipt {
    seq: number;
    runId: string;
    at: string | null;
    signed: boolean;
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

/**
 * One entry of "Waiting for you" (GET /api/cowork/needs-you, server/usecases/coworkNeedsYou.mts): something of the
 * owner's own Cowork work that waits for them. `kind` is decision, review, sign_in or plan; `plan` says where a plan
 * stands (first, changed, blocked, gone).
 */
export interface CoworkNeed {
    kind: string;
    itemId: string;
    title: string;
    plan: string | null;
}

/** An item's goal as the phone shows it: the sentence and its latest count (server/usecases/coworkGoals.mts). */
export interface CoworkGoalLine {
    sentence: string;
    met: number | null;
    total: number | null;
}
