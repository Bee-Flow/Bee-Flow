/**
 * The budgets of one server step of an App Studio action, by kind: which kinds are heavy
 * (they spend the owner's model quota, mail allowance or storage and need a role), which are
 * model calls, and which per-(viewer, app) limiters a step of a kind is charged against, in
 * order. One list for the /step route and a background job (backgroundRun.mts), so a click and
 * a job spend the same buckets.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

// Step kinds that cost what a /run costs: a full automation, a model call, or a write into the
// owner's storage envelope. fill_document renders a page in Chromium; dataset_query is NOT
// here (a bounded ranged read, its own bucket below).
export const HEAVY_STEP_KINDS: readonly string[] = Object.freeze(['run_automation', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'copy_document']);

// The model calls among them: still heavy (role gate), budgeted on their own bucket, because an
// action legitimately repeats them once per document.
export const AI_STEP_KINDS: readonly string[] = Object.freeze(['ai_extract', 'ai_generate', 'kb_query', 'redact_pdf']);

export type Limiter = {
    check: (req: unknown, res: unknown) => Promise<boolean>;
    take: (key: string, cost?: number) => Promise<{ ok: true } | { ok: false; retryAfterSecs: number }>;
    limiterName?: string | null;
};

export type StepBudget = { limiter: Limiter; name: string; daily: boolean };

/** The limiters a step of `kind` is charged against, in the order /step charges them. */
export function limitersForStep(kind: string, limiters: Record<string, Limiter> = nodeRequire('./studioAppRateLimits')): StepBudget[] {
    const out: StepBudget[] = [];
    if (AI_STEP_KINDS.includes(kind)) out.push({ limiter: limiters.aiStepLimiter, name: 'STUDIO_APP_AI_STEP_RPM', daily: false });
    else if (HEAVY_STEP_KINDS.includes(kind)) out.push({ limiter: limiters.actionRunLimiter, name: 'STUDIO_APP_ACTION_RUN_RPM', daily: false });
    if (kind === 'send_email') {
        out.push({ limiter: limiters.sendEmailLimiter, name: 'STUDIO_APP_SEND_EMAIL_RPM', daily: false });
        out.push({ limiter: limiters.sendEmailDailyLimiter, name: 'STUDIO_APP_SEND_EMAIL_DAILY', daily: true });
    }
    if (kind === 'file_intake') out.push({ limiter: limiters.fileIntakeLimiter, name: 'STUDIO_APP_FILE_INTAKE_RPM', daily: false });
    if (kind === 'dataset_query') out.push({ limiter: limiters.datasetQueryLimiter, name: 'STUDIO_APP_DATASET_QUERY_RPM', daily: false });
    return out;
}
