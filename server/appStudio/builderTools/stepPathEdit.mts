/**
 * app_update_step: change ONE step of an action, addressed by its walker path (the paths
 * app_run_action, app_get_run and app_save_test speak: "steps[0]", "steps[1].then[0]",
 * "steps[2].cases[0].steps[1]", "steps[0].onError.steps[0]"; "action[0]" is a bare action itself).
 *
 * The path must be one sequencePaths.stepPaths lists for the action, so the tool addresses
 * exactly the steps a walk reports. The changed action then goes through app_set_action's own
 * path (repair, the validator's rules for this action, the limit refusals, canonicalize), so a
 * step edit is held to the rules of a whole-action save. Every other step keeps its bytes: the
 * edit is made on a copy of the stored (canonical) action and touches only the addressed step.
 *
 * A path into a called action (".call.steps[...]") is not this action's step: the refusal names
 * the action to edit instead.
 */

import { createRequire } from 'node:module';
import { childStepSlots } from '../../shared/appDefinition/stepFlow.mjs';
import { stepPaths, topOf } from '../sequencePaths.mts';
import { pickClosestId } from '../../utils/closestId.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Draft = { def: { actions?: Record<string, unknown> } & Obj } & Obj;
type Result = Obj & { error?: string; _fixHint?: string; _hints?: string[] };

const MAX_LISTED_PATHS = 40;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The list holding the step at `path` and its index there, inside `action` (walked slots only). */
function locate(list: unknown[], base: string, path: string): { list: unknown[]; index: number } | null {
    for (let i = 0; i < list.length; i += 1) {
        const step = list[i];
        const here = `${base}[${i}]`;
        if (here === path) return { list, index: i };
        if (!isObject(step) || !path.startsWith(`${here}.`)) continue;
        for (const slot of childStepSlots(step)) {
            if (!slot.walked) continue;
            const hit = locate(slot.steps, `${here}${slot.suffix}`, path);
            if (hit) return hit;
        }
    }
    return null;
}

/** The step at `path` of `action`, or undefined. */
export function stepAt(action: unknown, path: string): unknown {
    const { list, base } = topOf(action);
    const hit = locate(list, base, path);
    return hit ? hit.list[hit.index] : undefined;
}

function pathList(action: unknown): string {
    const paths = stepPaths(action);
    const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `${p.path} (${p.kind})`).join(', ');
    return `${shown || '(none)'}${paths.length > MAX_LISTED_PATHS ? `, … ${paths.length - MAX_LISTED_PATHS} more` : ''}`;
}

/** The new step: the patch merged over the old one (null removes a key), or the replacement. */
function nextStep(old: Obj, args: Obj): Obj | Result {
    const hasPatch = args.patch !== undefined;
    const hasStep = args.step !== undefined;
    if (hasPatch === hasStep) {
        return { error: 'Pass exactly one of patch (the fields to change) or step (the whole new step).', _fixHint: 'e.g. { actionId, path: "steps[1]", patch: { message: { kind: "static", value: "Saved" } } }.' };
    }
    if (hasStep) {
        if (!isObject(args.step) || typeof args.step.kind !== 'string') return { error: 'step must be a whole step object with its kind.', _fixHint: 'Read the action with app_get_action; to change a few fields, pass patch instead.' };
        return structuredClone(args.step);
    }
    if (!isObject(args.patch) || !Object.keys(args.patch).length) return { error: 'patch must be an object with at least one field.', _fixHint: 'A field set to null is removed from the step.' };
    const out: Obj = structuredClone(old);
    for (const [key, value] of Object.entries(args.patch)) {
        if (value === null) delete out[key];
        else out[key] = structuredClone(value);
    }
    return out;
}

function readTarget(draftWrap: Draft, args: Obj): { actionId: string; action: Obj; path: string } | Result {
    const actions = isObject(draftWrap.def.actions) ? draftWrap.def.actions : {};
    const actionId = typeof args.actionId === 'string' ? args.actionId : '';
    if (!actionId || !Object.hasOwn(actions, actionId) || !isObject(actions[actionId])) {
        const suggestion = pickClosestId(actionId, Object.keys(actions));
        return { error: `Unknown actionId ${JSON.stringify(args.actionId ?? null)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: 'Use an act_… id from app_get_draft.' };
    }
    const action = actions[actionId] as Obj;
    const path = typeof args.path === 'string' ? args.path.trim() : '';
    const callAt = path.indexOf('.call.');
    if (callAt > 0) {
        const callee = stepAt(action, path.slice(0, callAt));
        const owner = isObject(callee) && typeof callee.actionId === 'string' ? callee.actionId : 'the called action';
        let rest = path.slice(callAt + '.call.'.length);
        // A bare called action is its own step 0: in its own frame that is action[0].
        const calleeAction = Object.hasOwn(actions, owner) ? actions[owner] : null;
        if (isObject(calleeAction) && calleeAction.kind !== 'sequence' && rest.startsWith('steps[0]')) rest = `action[0]${rest.slice('steps[0]'.length)}`;
        return { error: `${path} is a step of ${owner}, which this action calls, not a step of ${actionId}.`, _fixHint: `Edit it there: app_update_step { actionId: "${owner}", path: "${rest}" }.` };
    }
    if (!stepPaths(action).some((p) => p.path === path)) {
        return { error: `${actionId} has no step at ${JSON.stringify(path)}.`, _fixHint: `Its step paths: ${pathList(action)}.` };
    }
    return { actionId, action, path };
}

/** app_update_step { actionId, path, patch | step }. */
export async function applyUpdateStep(draftWrap: Draft, rawArgs: unknown): Promise<Result> {
    const args = isObject(rawArgs) ? rawArgs : {};
    const target = readTarget(draftWrap, args);
    if ('error' in target) return target as Result;
    const { actionId, action, path } = target as { actionId: string; action: Obj; path: string };
    const copy = structuredClone(action);
    const { list, base } = topOf(copy);
    const hit = locate(list, base, path);
    if (!hit) return { error: `${actionId} has no step at ${JSON.stringify(path)}.`, _fixHint: `Its step paths: ${pathList(action)}.` };
    const step = nextStep(hit.list[hit.index] as Obj, args);
    if ('error' in step) return step as Result;
    hit.list[hit.index] = step;
    const next = base === 'action' ? list[0] : copy;
    if (JSON.stringify(next) === JSON.stringify(action)) return { actionId, path, note: 'No change: the step already had these values.' };
    const { applySetActionTool } = nodeRequire('./definitionTools/actions.js') as { applySetActionTool: (d: Draft, a: Obj) => Promise<Result> };
    const result = await applySetActionTool(draftWrap, { actionId, action: next });
    if (result.error) return result;
    delete result.action;
    const saved = isObject(draftWrap.def.actions) ? draftWrap.def.actions[actionId] : undefined;
    const now = stepAt(saved, path);
    return { ...result, path, ...(now !== undefined ? { step: now } : { note: `The action was saved, but its steps were rearranged, so ${path} now names another place: read it with app_get_action.` }) };
}
