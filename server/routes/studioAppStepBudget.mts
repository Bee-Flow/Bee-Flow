/**
 * The budgets of one server step of an App Studio action, by kind: which kinds are heavy
 * (they spend the owner's model quota, mail allowance or storage and need a role), which are
 * model calls, and which per-(viewer, app) limiters a step of a kind is charged against, in
 * order. One list for the /step route and a background job (backgroundRun.mts), so a click and
 * a job spend the same buckets.
 */

import { createRequire } from 'node:module';

import { isBulkWriteStep } from '../appStudio/bulkWritePolicy.mts';

const nodeRequire = createRequire(import.meta.url);

const { STEP_POLICY_LISTS } = nodeRequire('../appStudio/componentSpecs/stepRegistry.js') as {
    STEP_POLICY_LISTS: { heavyStepKinds: readonly string[]; aiStepKinds: readonly string[] };
};

// Step kinds that cost what a /run costs: a full automation, a model call, or a write into the
// owner's storage envelope. fill_document renders a page in Chromium; dataset_query is NOT
// here (a bounded ranged read, its own bucket below). Derived: the server kinds whose `budget`
// is 'heavy' or 'ai' (componentSpecs/stepMeta.js, or the kind's own registry file).
export const HEAVY_STEP_KINDS: readonly string[] = STEP_POLICY_LISTS.heavyStepKinds;

// The model calls among them (`budget: 'ai'`): still heavy (role gate), budgeted on their own
// bucket, because an action legitimately repeats them once per document.
export const AI_STEP_KINDS: readonly string[] = STEP_POLICY_LISTS.aiStepKinds;

export type Limiter = {
    check: (req: unknown, res: unknown) => Promise<boolean>;
    take: (key: string, cost?: number) => Promise<{ ok: true } | { ok: false; retryAfterSecs: number }>;
    limiterName?: string | null;
};

export type StepBudget = { limiter: Limiter; name: string; daily: boolean };

/**
 * The limiters a step of `kind` is charged against, in the order /step charges them. `bulk`: the
 * step is a bulk write (filter-mode update/delete_record or a writeTo replaceWhere, package 5),
 * which changes up to 500 rows in one step and so costs a run, not a step.
 */
export function limitersForStep(kind: string, limiters: Record<string, Limiter> = nodeRequire('./studioAppRateLimits'), bulk = false): StepBudget[] {
    const out: StepBudget[] = [];
    if (AI_STEP_KINDS.includes(kind)) out.push({ limiter: limiters.aiStepLimiter, name: 'STUDIO_APP_AI_STEP_RPM', daily: false });
    else if (HEAVY_STEP_KINDS.includes(kind) || bulk) out.push({ limiter: limiters.actionRunLimiter, name: 'STUDIO_APP_ACTION_RUN_RPM', daily: false });
    if (kind === 'send_email') {
        out.push({ limiter: limiters.sendEmailLimiter, name: 'STUDIO_APP_SEND_EMAIL_RPM', daily: false });
        out.push({ limiter: limiters.sendEmailDailyLimiter, name: 'STUDIO_APP_SEND_EMAIL_DAILY', daily: true });
    }
    if (kind === 'file_intake') out.push({ limiter: limiters.fileIntakeLimiter, name: 'STUDIO_APP_FILE_INTAKE_RPM', daily: false });
    if (kind === 'dataset_query') out.push({ limiter: limiters.datasetQueryLimiter, name: 'STUDIO_APP_DATASET_QUERY_RPM', daily: false });
    return out;
}

/** The limiters of one resolved step: its kind, plus the per-run bucket for a bulk write. */
export function limitersForStepDef(step: unknown, limiters?: Record<string, Limiter>): StepBudget[] {
    const kind = step !== null && typeof step === 'object' ? String((step as { kind?: unknown }).kind) : '';
    return limitersForStep(kind, limiters, isBulkWriteStep(step));
}
