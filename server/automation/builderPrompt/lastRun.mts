/**
 * The automation's latest run, as the builder's model reads it: the
 * "## Last run" block of the late dynamic message.
 *
 * The "## Last test run" block (./lastTestRun.mts) remembers the shapes of
 * the assistant's OWN dry runs. A run the person started from the canvas
 * ("Test step", "Run live", a dry run from the header) never passes through
 * the assistant, so without this block a person who says "fix this" after a
 * failed test meets an assistant that does not know which step failed or
 * why, and asks them to describe it.
 *
 * What the block holds, per step of the run: whether it ran, failed, waits or
 * was skipped, and for a failed step its error code and a short message. Never
 * an input or output value. The message is the step's error text, cut to
 * LAST_RUN_MAX_MESSAGE characters; the caller passes it through the same
 * personal-data mask builder_inspect_run applies (routes/ai/automationBuilder/
 * lastRunContext.mts) and hands only the masked text to renderLastRun.
 *
 * Pure.
 */

export type RunRow = {
    id?: unknown;
    mode?: unknown;
    isTest?: unknown;
    status?: unknown;
    startedAt?: unknown;
    finishedAt?: unknown;
};

export type StepRow = {
    stepId?: unknown;
    stepType?: unknown;
    status?: unknown;
    error?: unknown;
    errorClass?: unknown;
    errorInfo?: unknown;
};

export type StepState = 'ran' | 'failed' | 'handled' | 'waiting' | 'skipped' | 'cancelled' | 'other';

export type LastRunStep = {
    stepId: string;
    stepType?: string;
    state: StepState;
    /** The raw status word, kept for 'other'. */
    status?: string;
    /** The error code of a failed step (errorInfo.code, else the error class). */
    code?: string;
};

/** At most this many step lines; failed steps are always kept. */
export const LAST_RUN_MAX_STEPS = 40;
/** A failed step's message is cut to this many characters, before and after masking. */
export const LAST_RUN_MAX_MESSAGE = 200;
const MAX_ID = 120;
const MAX_WORD = 40;
const MAX_CODE = 60;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cut(v: unknown, max: number): string | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return undefined;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A code is an identifier: anything else in it is dropped. */
function codeOf(row: StepRow): string | undefined {
    const raw = isPlainObject(row.errorInfo) && typeof row.errorInfo.code === 'string' ? row.errorInfo.code : row.errorClass;
    const code = typeof raw === 'string' ? raw.replace(/[^\w.:-]/g, '').slice(0, MAX_CODE) : '';
    return code || undefined;
}

function stateOf(status: string | undefined): StepState {
    if (!status) return 'other';
    if (status === 'handled_error') return 'handled';
    if (/fail|error|rejected|expired/i.test(status)) return 'failed';
    if (['success', 'done', 'completed', 'approved'].includes(status)) return 'ran';
    if (/^awaiting|waiting|pending|running|queued|paused/i.test(status)) return 'waiting';
    if (status === 'skipped') return 'skipped';
    if (status === 'cancelled' || status === 'canceled') return 'cancelled';
    return 'other';
}

const isFailure = (s: StepState): boolean => s === 'failed' || s === 'handled';

/**
 * One line per step of a run's step rows, in run order. A step recorded more
 * than once (attempts, a loop body) keeps its failed row when one failed and
 * its last row otherwise. `errors` holds the raw error text of each failed
 * step, cut to LAST_RUN_MAX_MESSAGE: it still has to pass the mask.
 */
export function summariseRunSteps(rows: unknown): { steps: LastRunStep[]; errors: Record<string, string> } {
    const byId = new Map<string, { step: LastRunStep; error?: string }>();
    for (const raw of Array.isArray(rows) ? rows : []) {
        if (!isPlainObject(raw)) continue;
        const row = raw as StepRow;
        const stepId = cut(row.stepId, MAX_ID);
        if (!stepId) continue;
        const status = cut(row.status, MAX_WORD);
        const state = stateOf(status);
        const had = byId.get(stepId);
        if (had && isFailure(had.step.state) && !isFailure(state)) continue;
        const step: LastRunStep = { stepId, state };
        const stepType = cut(row.stepType, MAX_WORD);
        if (stepType) step.stepType = stepType;
        if (state === 'other' && status) step.status = status;
        const failed = isFailure(state);
        const code = failed ? codeOf(row) : undefined;
        if (code) step.code = code;
        const error = failed ? cut(row.error, LAST_RUN_MAX_MESSAGE) : undefined;
        byId.delete(stepId);
        byId.set(stepId, { step, ...(error ? { error } : {}) });
    }
    const steps: LastRunStep[] = [];
    const errors: Record<string, string> = {};
    for (const [id, { step, error }] of byId) {
        steps.push(step);
        if (error) errors[id] = error;
    }
    return { steps, errors };
}

/** When the run last changed: its end, else its start; NaN when neither is known. */
function runTime(run: RunRow): number {
    const at = typeof run.finishedAt === 'string' ? run.finishedAt : typeof run.startedAt === 'string' ? run.startedAt : '';
    return at ? Date.parse(at) : Number.NaN;
}

/**
 * Is this run newer than what the builder session already knows (the
 * session's last write, `snapshot.updatedAt`)? A session that never wrote
 * knows nothing yet; a run without a time is not trusted to be newer.
 */
export function runIsNewer(run: unknown, since: unknown): boolean {
    if (!isPlainObject(run)) return false;
    const at = runTime(run as RunRow);
    if (Number.isNaN(at)) return false;
    const known = typeof since === 'string' ? Date.parse(since) : Number.NaN;
    return Number.isNaN(known) || at > known;
}

function runWords(run: RunRow): string {
    const kind = run.mode === 'dry_run' ? 'a dry run (nothing was sent)' : run.isTest ? 'a test run' : 'a live run';
    const status = cut(run.status, MAX_WORD);
    const state = stateOf(status);
    const words = status ? status.replace(/_/g, ' ') : '';
    const ended = !status ? ''
        : state === 'ran' ? ', it finished'
            : state === 'failed' ? ', it failed'
                : state === 'cancelled' ? ', it was cancelled'
                    : state === 'waiting' ? `, it is still ${words}` : `, it ended ${words}`;
    const started = cut(run.startedAt, MAX_WORD);
    return `The latest run of this automation was ${kind}${started ? ` started ${started}` : ''}${ended}.`;
}

function stepWords(step: LastRunStep, message: string | undefined): string {
    const type = step.stepType ? ` (${step.stepType})` : '';
    const head = `- \`${step.stepId}\`${type}`;
    if (isFailure(step.state)) {
        const code = step.code ? ` with code \`${step.code}\`` : '';
        const handled = step.state === 'handled' ? ' (its error path took over)' : '';
        return `${head} failed${code}${handled}${message ? `: ${message}` : ''}`;
    }
    if (step.state === 'ran') return `${head} ran`;
    if (step.state === 'waiting') return `${head} is waiting`;
    if (step.state === 'skipped') return `${head} was skipped`;
    if (step.state === 'cancelled') return `${head} was cancelled`;
    return `${head} ended ${step.status || 'without a status'}`;
}

/**
 * The "## Last run" block, or '' when the run recorded no step. `messages`
 * are the MASKED error texts by step id (cut again here). `canInspect`: the
 * turn offers builder_inspect_run.
 */
export function renderLastRun(run: unknown, steps: readonly LastRunStep[], messages: Record<string, unknown> = {}, { canInspect = true }: { canInspect?: boolean } = {}): string {
    if (!isPlainObject(run) || !steps.length) return '';
    const failed = steps.filter((s) => isFailure(s.state));
    const room = Math.max(0, LAST_RUN_MAX_STEPS - failed.length);
    let others = 0;
    const shown = steps.filter((s) => {
        if (isFailure(s.state)) return true;
        others += 1;
        return others <= room;
    });
    const lines = shown.map((s) => stepWords(s, cut(messages[s.stepId], LAST_RUN_MAX_MESSAGE)));
    const hidden = steps.length - shown.length;
    if (hidden > 0) lines.push(`- … and ${hidden} more step${hidden === 1 ? '' : 's'} that did not fail`);
    const out = [
        '## Last run',
        `${runWords(run as RunRow)} What each step did (error texts shortened, personal data masked, no input or output values):`,
        ...lines,
    ];
    if (failed.length) {
        const read = canInspect
            ? `FIRST read this run with builder_inspect_run on the failed step${failed.length > 1 ? 's' : ''}, then name the step that failed and why in one sentence`
            : 'FIRST name the step that failed and why in one sentence, from this block';
        out.push(`When the person asks you to fix something or to look at what went wrong, ${read}. Never ask them to describe an error this run already holds.`);
    }
    return out.join('\n');
}
