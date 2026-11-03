/**
 * Start (or continue) a run for an HTTP caller, and answer within a cap.
 *
 * Five routes start or continue a run on a person's request: POST /:id/run,
 * /:id/dry-run, /:id/steps/:stepId/run, POST /runs/:runId/form and the approve
 * resume in automation/approvalDecision.js. They all answer one of two ways:
 *
 *   { kind: 'finished', run }   the run ended or paused within the cap
 *   { kind: 'pending', runId }  it is still going; the client follows runId
 *
 * A pending answer ALWAYS carries the run id: a 202 without one leaves the
 * builder nothing to follow, so a pause after a slow AI step goes unseen and
 * the form overlay says "finished" while the run goes on (run-watch F1).
 *
 * `respond: 'created'` answers pending as soon as the run row exists (the
 * builder follows every run by id); the default waits for the end, up to the
 * cap, so mobile, MCP and API callers keep their synchronous answer.
 *
 * The runner promise keeps running after a pending answer; a later failure is
 * logged. A refusal (HttpError, a managed automation without a deployed copy)
 * reaches the caller as thrown. A start that ends without a run and without a
 * run id is an error, never a "still running" 202.
 *
 * Limit: AUTOMATION_RUN_RESPONSE_CAP_MS, default 50000 (under the 60 s proxy
 * timeout), 0 = wait for the end.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const DEFAULT_RUN_RESPONSE_CAP_MS = 50_000;

type LogLike = { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
export type RespondMode = 'created' | 'finished';
export type CreatedRun = { id?: unknown } | null | undefined;
export type StartRun<R> = (onRunCreated: (run: CreatedRun) => void) => Promise<R | null | undefined> | R | null | undefined;
export type CappedResult<R> = { kind: 'finished'; run: R } | { kind: 'pending'; runId: string };
export interface CapOptions {
    /** Milliseconds to wait for the end; 0 waits for the end. Defaults to the env value. */
    capMs?: number;
    respond?: RespondMode | null;
    /** Names the route in the log lines. */
    label?: string;
    log?: LogLike;
    env?: Record<string, string | undefined>;
}

/** Env value to milliseconds: unset, blank, negative or not a number gives the default; 0 means wait for the end. */
export function runResponseCapMs(env: Record<string, string | undefined> = process.env): number {
    const raw = env.AUTOMATION_RUN_RESPONSE_CAP_MS;
    if (raw === undefined || String(raw).trim() === '') return DEFAULT_RUN_RESPONSE_CAP_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_RUN_RESPONSE_CAP_MS;
    return Math.floor(n);
}

/** A refusal the caller must see as such: an HttpError, or a managed automation that has no deployed copy. */
function isRefusal(e: unknown): boolean {
    const { HttpError } = nodeRequire('../http/errors') as { HttpError: new (...a: unknown[]) => Error };
    if (e instanceof HttpError) return true;
    return typeof e === 'object' && e !== null && (e as { errorClass?: unknown }).errorClass === 'managed_part_not_deployed';
}

function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function idOf(run: CreatedRun): string | null {
    const id = run && typeof run === 'object' ? run.id : null;
    return typeof id === 'string' && id ? id : null;
}

/** The 202 body every capped route answers with. */
export function pendingRunBody(runId: string, message = 'The run is still going. Follow it by its id.'): { accepted: true; pending: true; runId: string; message: string } {
    return { accepted: true, pending: true, runId, message };
}

export function startCapped<R extends object>(start: StartRun<R>, opts: CapOptions = {}): Promise<CappedResult<R>> {
    const capMs = typeof opts.capMs === 'number' && opts.capMs >= 0 ? opts.capMs : runResponseCapMs(opts.env);
    const respond: RespondMode = opts.respond === 'created' ? 'created' : 'finished';
    const log: LogLike = opts.log ?? nodeRequire('../../telemetry/log');
    const label = opts.label ?? 'automation/run';

    return new Promise<CappedResult<R>>((resolve, reject) => {
        let runId: string | null = null;
        let decided = false;
        let capped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const decide = (fn: () => void): void => {
            if (decided) return;
            decided = true;
            if (timer) clearTimeout(timer);
            fn();
        };
        // Pending only once the id is known: after the cap without an id the
        // answer waits for whichever comes first, the id or the end.
        const answerPending = (): void => {
            const id = runId;
            if (id) decide(() => resolve({ kind: 'pending', runId: id }));
        };
        const onRunCreated = (run: CreatedRun): void => {
            const id = idOf(run);
            if (!id || runId) return;
            runId = id;
            if (respond === 'created' || capped) answerPending();
        };

        if (capMs > 0) {
            timer = setTimeout(() => { capped = true; answerPending(); }, capMs);
        }

        let started: Promise<R | null | undefined>;
        try {
            started = Promise.resolve(start(onRunCreated));
        } catch (e) {
            started = Promise.reject(e);
        }

        started.then((run) => {
            if (decided) return;
            if (run != null) { decide(() => resolve({ kind: 'finished', run })); return; }
            if (runId) { answerPending(); return; }
            decide(() => reject(new Error('The run did not start: the runner returned no run.')));
        }, (e: unknown) => {
            if (decided) {
                log.error(`[${label}] run ${runId ?? '(no id)'} failed after the response was sent: ${messageOf(e)}`);
                return;
            }
            if (isRefusal(e) || !runId) { decide(() => reject(e)); return; }
            // The run row exists: the caller follows it and reads its fate there.
            log.error(`[${label}] run ${runId} failed: ${messageOf(e)}`);
            answerPending();
        });
    });
}
