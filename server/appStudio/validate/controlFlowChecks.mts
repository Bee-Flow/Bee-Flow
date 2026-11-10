/**
 * App Studio validator: the control-flow step kinds of the step registry.
 *
 *   checkLoopExit  a break or continue sits inside the steps of a loop or while of its
 *                  own action (a condition, switch, try or handler in between is fine).
 *                  A call_action is a boundary: the called action is checked on its own.
 *   checkWhile     a while is a loop: no send_email inside it, directly or through a call.
 *                  (What a loop holding a costly kind is told comes from stepKindChecks.)
 *   checkTry       a try that can never do anything a plain list would not.
 *
 * The step tree is read through stepFlow.childStepSlots, so a container added later is
 * walked without an edit here. This file never imports validate.js.
 */

import { createRequire } from 'node:module';
import type * as ActionCalls from '../actionCalls.mts';
import type * as StepFlow from '../../shared/appDefinition/stepFlow.mjs';

const nodeRequire = createRequire(import.meta.url);
// Required, not imported: agent-hub's typecheck reaches this file through validate.js,
// and its tsconfig refuses a `.mts` import path (the other validate/*.mts do the same).
const { someStepThroughCalls } = nodeRequire('../actionCalls.mts') as typeof ActionCalls;
const { childStepSlots } = nodeRequire('../../shared/appDefinition/stepFlow.mjs') as typeof StepFlow;

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; actions?: Obj | null };

/** The kinds whose own steps are the rounds a break or continue belongs to. */
const LOOP_KINDS: readonly string[] = Object.freeze(['loop', 'while']);
/** Hand-written definitions can nest without end; the scan stops here (the validator reports the depth itself). */
const MAX_SCAN_DEPTH = 24;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Per actions map: the break and continue steps that sit inside a loop or while. */
const insideLoop = new WeakMap<object, WeakSet<object>>();

function collectInside(list: unknown, inLoop: boolean, depth: number, out: WeakSet<object>): void {
    if (!Array.isArray(list) || depth > MAX_SCAN_DEPTH) return;
    for (const step of list) {
        if (!isObject(step)) continue;
        if (inLoop && (step.kind === 'break' || step.kind === 'continue')) out.add(step);
        const loops = LOOP_KINDS.includes(String(step.kind));
        for (const slot of childStepSlots(step)) {
            // A handler of a loop step is not one of its rounds.
            const body = loops && slot.suffix !== '.onError.steps';
            collectInside(slot.steps, inLoop || body, depth + 1, out);
        }
    }
}

function exitsInsideLoops(actions: Obj): WeakSet<object> {
    const known = insideLoop.get(actions);
    if (known) return known;
    const out = new WeakSet<object>();
    for (const action of Object.values(actions)) {
        if (isObject(action) && action.kind === 'sequence') collectInside(action.steps, false, 1, out);
    }
    insideLoop.set(actions, out);
    return out;
}

/** break / continue: only inside the steps of a loop or while of the same action. */
export function checkLoopExit(step: Obj, path: string, ctx: Ctx): void {
    if (isObject(ctx.actions) && exitsInsideLoops(ctx.actions).has(step)) return;
    const kind = String(step.kind);
    ctx.pushE({
        code: 'action.step_outside_loop', severity: 'error', path,
        message: `A "${kind}" step only works inside the steps of a loop or while.`,
        hint: kind === 'break'
            ? 'Move it into the loop it should leave. To end the whole action early, use a return step. A loop in another action cannot be left through call_action.'
            : 'Move it into the loop whose round it should skip. A loop in another action cannot be reached through call_action.',
    });
}

/** while: the mail rule of a loop. */
export function checkWhile(step: Obj, path: string, ctx: Ctx): void {
    if (!someStepThroughCalls(step.steps, ctx.actions, (s) => s.kind === 'send_email')) return;
    ctx.pushE({
        code: 'action.send_email_in_loop', severity: 'error', path: `${path}.steps`,
        message: 'A "send email" step may not run inside a loop.',
        hint: 'Sending one message per round would mail everyone at once. Send a single message, or use an automation that controls its own pacing.',
    });
}

/** try: say so when it changes nothing. */
export function checkTry(step: Obj, path: string, ctx: Ctx): void {
    const steps = Array.isArray(step.steps) ? step.steps : [];
    if (!steps.length) {
        ctx.pushW({ code: 'action.try_empty', severity: 'warning', path: `${path}.steps`, message: 'This try has no steps, so there is nothing to catch.', hint: 'Put the steps that may fail in `steps`, or remove the try.' });
        return;
    }
    if (!Array.isArray(step.catch) && !Array.isArray(step.finally)) {
        ctx.pushW({ code: 'action.try_plain', severity: 'warning', path, message: 'This try has no catch and no finally, so a failure still ends the action.', hint: 'Add `catch` (the steps to run when one fails; [] to carry on silently) or `finally` (steps that always run).' });
    }
}
