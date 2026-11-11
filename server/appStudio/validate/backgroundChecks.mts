/**
 * App Studio validator — the run options of a sequence (background / lockKey / progressVar, and
 * runOn since 3).
 *
 * Errors: a malformed option, and (with background or runOn: 'server') a step that cannot run in
 * a server run (backgroundRunPolicy.backgroundActionProblems). Warnings: a lockKey on a sequence
 * the page walks (it locks nothing in the browser), a progressVar no step writes, and a background sequence
 * that another action calls (a called action runs inline in its caller: its own options are
 * ignored).
 */

import { createRequire } from 'node:module';
import type * as Policy from '../backgroundRunPolicy.mts';
import type * as ActionCalls from '../actionCalls.mts';

const nodeRequire = createRequire(import.meta.url);
// Required, not imported: agent-hub's typecheck reaches this file through validate.js (see callChecks.mts).
const { backgroundActionProblems, readRunOptions } = nodeRequire('../backgroundRunPolicy.mts') as typeof Policy;
const { callTargets, ownAction } = nodeRequire('../actionCalls.mts') as typeof ActionCalls;
const { childStepLists } = nodeRequire('../../shared/appDefinition/stepFlow.mjs') as { childStepLists: (s: unknown) => unknown[][] };
const { validateBinding } = nodeRequire('./bindings.js') as { validateBinding: (field: string, value: unknown, path: string, ctx: Ctx) => void };

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; actions?: Obj | null; knownVars?: Set<string> | null };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when a set_variable (or a resultVar) in the tree writes `name`. */
function writesVar(list: unknown, name: string, depth = 0): boolean {
    if (!Array.isArray(list) || depth > 12) return false;
    return list.some((s) => isObject(s) && ((s.kind === 'set_variable' && s.name === name) || s.resultVar === name
        || childStepLists(s).some((c) => writesVar(c, name, depth + 1))));
}

function checkFields(action: Obj, id: string, path: string, ctx: Ctx): void {
    if (action.background !== undefined && typeof action.background !== 'boolean') {
        ctx.pushE({ code: 'action.field_invalid', severity: 'error', path: `${path}.background`, message: `Action "${id}": background must be true or false.`, hint: 'Use background: true to run the sequence as a server job.' });
    }
    if (action.lockKey !== undefined) validateBinding('lockKey', action.lockKey, `${path}.lockKey`, ctx);
    if (action.runOn !== undefined && action.runOn !== 'server') {
        ctx.pushE({ code: 'action.field_invalid', severity: 'error', path: `${path}.runOn`, message: `Action "${id}": runOn must be "server".`, hint: 'Use runOn: "server" to run the whole sequence on the server, or leave it out: the page then walks the steps.' });
    }
    if (action.progressVar !== undefined && (typeof action.progressVar !== 'string' || !VAR_NAME_RE.test(action.progressVar) || action.progressVar.length > 60)) {
        ctx.pushE({ code: 'action.field_invalid', severity: 'error', path: `${path}.progressVar`, message: `Action "${id}": progressVar must be a variable name (a letter or _ first, at most 60 characters).`, hint: 'Name the variable a set_variable step writes, e.g. "status".' });
    }
}

/** The run options of sequence `id` (called from validateAction's sequence branch). */
export function checkRunOptions(action: Obj, id: string, path: string, ctx: Ctx): void {
    checkFields(action, id, path, ctx);
    const opts = readRunOptions(action);
    if (!opts.background && !opts.server) {
        if (opts.lockKey) ctx.pushW({ code: 'action.lock_without_background', severity: 'warning', path: `${path}.lockKey`, message: `Action "${id}" has a lockKey but does not run in the background, so nothing is locked.`, hint: 'Set background: true, or remove the lockKey.' });
        return;
    }
    for (const p of backgroundActionProblems(action, id, { resolveCalled: (cid) => ownAction(ctx.actions, cid) })) {
        ctx.pushE({ code: p.code, severity: 'error', path: `${path}.${p.path}`, message: p.message, hint: p.hint });
    }
    if (opts.progressVar && !writesVar(action.steps, opts.progressVar) && !(ctx.knownVars && ctx.knownVars.has(opts.progressVar))) {
        ctx.pushW({ code: 'action.progress_var_unknown', severity: 'warning', path: `${path}.progressVar`, message: `Action "${id}" shows vars.${opts.progressVar} as its progress, but no step of it writes that variable.`, hint: `Add set_variable steps with name "${opts.progressVar}" (e.g. "Reading document 2 of 5").` });
    }
    const caller = Object.entries(isObject(ctx.actions) ? ctx.actions : {}).find(([other, a]) => other !== id && callTargets(a).some((t) => t.actionId === id));
    if (caller && opts.background) {
        ctx.pushW({ code: 'action.background_in_called_action', severity: 'warning', path: `${path}.background`, message: `Action "${id}" runs in the background when it is clicked, but "${caller[0]}" calls it: a called action runs inside its caller, so there its background and lockKey are ignored.`, hint: 'Set background on the action that is clicked.' });
    } else if (caller) {
        ctx.pushW({ code: 'action.run_on_in_called_action', severity: 'warning', path: `${path}.runOn`, message: `Action "${id}" runs on the server when it is clicked, but "${caller[0]}" calls it: a called action runs inside its caller, wherever that runs, so there its runOn and lockKey are ignored.`, hint: 'Set runOn on the action that is clicked.' });
    }
}
