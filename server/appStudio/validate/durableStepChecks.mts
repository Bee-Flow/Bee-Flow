/**
 * App Studio validator — the steps that make a run wait (componentSpecs/steps/wait.js and
 * await_approval.js): where a long wait or a wait for a decision can be.
 *
 * Only a run on the server can be put on hold: a sequence with `runOn: 'server'` or
 * `background: true`, or an action such a sequence calls (a called action runs inside its
 * caller). Errors:
 *   - a wait that says neither how long nor until when, or says both;
 *   - a long wait (more than LIMITS.MAX_CLIENT_WAIT_SECONDS, or any `until`) or an await_approval
 *     in an action the page walks: the browser cannot hold it;
 *   - a long wait inside a branch of a parallel step: a branch cannot be put on hold (an
 *     await_approval there is the parallel check's, validate/parallelChecks.mts).
 * A short wait is the browser's wait and is fine everywhere.
 */

import { createRequire } from 'node:module';
import type * as Policy from '../backgroundRunPolicy.mts';
import type * as ActionCalls from '../actionCalls.mts';

const nodeRequire = createRequire(import.meta.url);
// Required, not imported: agent-hub's typecheck reaches this file through validate.js (see callChecks.mts).
const { runsOnServer } = nodeRequire('../backgroundRunPolicy.mts') as typeof Policy;
const { callTargets } = nodeRequire('../actionCalls.mts') as typeof ActionCalls;
const { childStepSlots } = nodeRequire('../../shared/appDefinition/stepFlow.mjs') as { childStepSlots: (s: unknown) => Array<{ steps: unknown; suffix: string }> };
const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as { LIMITS: { MAX_CLIENT_WAIT_SECONDS: number; MAX_ACTION_DEPTH: number } };

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; actions?: Obj | null };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const WAITING_KINDS = ['wait', 'await_approval'];
const SERVER_HINT = 'Set runOn: "server" (the page waits for the end) or background: true on this sequence, or call it from an action that has one.';

/** True when the wait is longer than the browser holds one (or names a moment). */
export function isLongWait(step: Obj): boolean {
    if (step.until !== undefined && step.until !== null) return true;
    return typeof step.seconds === 'number' && step.seconds > LIMITS.MAX_CLIENT_WAIT_SECONDS;
}

/** Does any step of the tree make the run wait (a wait or an await_approval)? Cheap: most actions have none. */
function holdsWaitingStep(list: unknown, depth = 0): boolean {
    if (!Array.isArray(list) || depth > LIMITS.MAX_ACTION_DEPTH + 1) return false;
    return list.some((s) => isObject(s) && (WAITING_KINDS.includes(String(s.kind)) || childStepSlots(s).some((sl) => holdsWaitingStep(sl.steps, depth + 1))));
}

/** True when an action that runs on the server calls `id`: its steps then run in that server run. */
function calledFromServerRun(id: string, ctx: Ctx): boolean {
    const actions = isObject(ctx.actions) ? ctx.actions : {};
    return Object.entries(actions).some(([other, a]) => other !== id && runsOnServer(a) && callTargets(a).some((t) => t.actionId === id));
}

function checkWaitShape(step: Obj, path: string, ctx: Ctx): void {
    const hasSeconds = step.seconds !== undefined && step.seconds !== null;
    const hasUntil = step.until !== undefined && step.until !== null;
    if (hasSeconds === hasUntil) {
        ctx.pushE({
            code: hasSeconds ? 'action.wait_two_durations' : 'action.wait_without_duration', severity: 'error', path,
            message: hasSeconds ? 'This wait gives both seconds and until.' : 'This wait says neither how many seconds nor until when.',
            hint: 'Give exactly one: seconds (a whole number) or until (a date-time binding).',
        });
    }
}

type Walk = { id: string; server: boolean; ctx: Ctx };

function checkStep(step: Obj, path: string, inParallel: boolean, walk: Walk): void {
    const { ctx } = walk;
    if (step.kind === 'wait') {
        checkWaitShape(step, path, ctx);
        if (!isLongWait(step)) return;
        if (inParallel) {
            ctx.pushE({
                code: 'action.wait_in_parallel', severity: 'error', path,
                message: `A wait longer than ${LIMITS.MAX_CLIENT_WAIT_SECONDS} seconds (or until a moment) cannot be inside a branch of a parallel step: a branch cannot be put on hold.`,
                hint: 'Move the wait before or after the parallel step.',
            });
        } else if (!walk.server) {
            ctx.pushE({
                code: 'action.wait_needs_server_run', severity: 'error', path,
                message: `Action "${walk.id}" is walked by the page, which holds a wait of at most ${LIMITS.MAX_CLIENT_WAIT_SECONDS} seconds; this one is longer (or waits until a moment).`,
                hint: SERVER_HINT,
            });
        }
    } else if (step.kind === 'await_approval' && !walk.server) {
        ctx.pushE({
            code: 'action.await_approval_needs_server_run', severity: 'error', path,
            message: `Action "${walk.id}" is walked by the page, which cannot wait for an approval: the decision may take days.`,
            hint: SERVER_HINT,
        });
    }
}

function visit(list: unknown, base: string, inParallel: boolean, depth: number, walk: Walk): void {
    if (!Array.isArray(list) || depth > LIMITS.MAX_ACTION_DEPTH + 1) return;
    list.forEach((step, i) => {
        if (!isObject(step)) return;
        const path = `${base}[${i}]`;
        checkStep(step, path, inParallel, walk);
        for (const slot of childStepSlots(step)) visit(slot.steps, `${path}${slot.suffix}`, inParallel || slot.suffix.startsWith('.branches['), depth + 1, walk);
    });
}

/** The checks above for the sequence `action` (id `id`) at `path`. */
export function checkWaitingSteps(action: Obj, id: string, path: string, ctx: Ctx): void {
    if (!holdsWaitingStep(action.steps)) return;
    const server = runsOnServer(action) || calledFromServerRun(id, ctx);
    visit(action.steps, `${path}.steps`, false, 1, { id, server, ctx });
}
