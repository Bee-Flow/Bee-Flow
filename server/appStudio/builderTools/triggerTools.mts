/**
 * app_set_trigger / app_remove_trigger: the AI builder writes `definition.triggers`
 * (triggers/triggerSpec.mts). Registry tools (builderTools/tools/app_set_trigger.js,
 * app_remove_trigger.js).
 *
 * A call changes the DRAFT only. Nothing is armed by it: a trigger starts to run when a person
 * publishes the app (triggers/triggerSync.mts). The tool refuses what the validator would refuse,
 * with the reason: an unknown action, a schedule that cannot be read, an action with a step
 * that may not run unattended (triggers/unattendedPolicy.mts).
 */

import { createRequire } from 'node:module';
import { ownAction } from '../actionCalls.mts';
import { triggerKind, triggerKinds } from '../triggers/triggerKinds.mts';
import { MAX_TRIGGERS, readTriggers } from '../triggers/triggerSpec.mts';
import { UNATTENDED_HINT, unattendedActionProblems } from '../triggers/unattendedPolicy.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Draft = { def: Obj };
type Result = Obj;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const adopt = (draftWrap: Draft, next: Obj, result: Result): Result => (nodeRequire('./shared.js') as { adoptCanonical: (d: Draft, n: Obj, r: Result) => Result }).adoptCanonical(draftWrap, next, result);

const NOT_ARMED = 'Saved in the draft. It starts to run when the app is published, as the app owner; tell the user that publishing is what switches it on.';

/** The trigger the call describes, or the refusal. */
function readCall(def: Obj, args: Obj): { trigger: Obj } | { refusal: Result } {
    const actions = isObject(def.actions) ? def.actions : {};
    const kind = triggerKind(args.kind ?? 'schedule');
    if (!kind) return { refusal: { error: `Unknown trigger kind ${JSON.stringify(args.kind)}.`, _fixHint: `Known kinds: ${triggerKinds().map((k) => k.kind).join(', ')}.` } };
    const actionId = typeof args.actionId === 'string' ? args.actionId : '';
    const action = ownAction(actions, actionId);
    if (!action) {
        return { refusal: { error: `Unknown actionId ${JSON.stringify(args.actionId ?? null)}.`, _fixHint: `Create the action first with app_set_action. Actions: ${Object.keys(actions).join(', ') || '(none yet)'}.` } };
    }
    const problems = unattendedActionProblems(action, actionId, { resolveCalled: (id) => ownAction(actions, id), refusedKinds: kind.refusedKinds });
    if (problems.length) return { refusal: { error: problems.map((p) => p.message).join(' '), _fixHint: UNATTENDED_HINT } };
    const raw: Obj = { id: args.id, kind: kind.kind, actionId };
    for (const field of kind.fields) if (args[field] !== undefined) raw[field] = args[field];
    if (args.enabled === false) raw.enabled = false;
    // The kind's own reading of its fields, with its reason when it refuses them.
    const reasons: string[] = [];
    const own = kind.canon(raw, 'trigger', (_code, _path, message) => { reasons.push(message); });
    if (!own) return { refusal: { error: reasons.join(' ') || 'The trigger could not be read.', _fixHint: `Shape: ${kind.shape}. ${kind.description}` } };
    return { trigger: { ...raw, ...own } };
}

/** Add a trigger, or replace the one with the same id. */
export function applySetTrigger(draftWrap: Draft, args: Obj): Result {
    const def = draftWrap.def;
    const read = readCall(def, isObject(args) ? args : {});
    if ('refusal' in read) return read.refusal;
    const list: Obj[] = readTriggers(def).map((t) => ({ ...t }));
    const id = typeof read.trigger.id === 'string' ? read.trigger.id : '';
    const at = list.findIndex((t) => t.id === id);
    if (at === -1 && list.length >= MAX_TRIGGERS) {
        return { error: `An app has at most ${MAX_TRIGGERS} triggers.`, _fixHint: 'Remove one with app_remove_trigger, or let one action do the work of two.' };
    }
    if (at === -1) list.push(read.trigger); else list[at] = read.trigger;
    const result = adopt(draftWrap, { ...def, triggers: list }, { ok: true, note: NOT_ARMED });
    if (result.error) return result;
    const written = readTriggers(draftWrap.def);
    // The id the canonicalizer kept (a missing one is numbered).
    result.trigger = at === -1 ? written[written.length - 1] : written[at];
    result.triggers = written.map((t) => t.id);
    return result;
}

/** Take a trigger out of the draft. */
export function applyRemoveTrigger(draftWrap: Draft, args: Obj): Result {
    const def = draftWrap.def;
    const list = readTriggers(def);
    const id = isObject(args) && typeof args.id === 'string' ? args.id : '';
    if (!list.some((t) => t.id === id)) {
        return { error: `Unknown trigger ${JSON.stringify(id || null)}.`, _fixHint: `Triggers of this app: ${list.map((t) => t.id).join(', ') || '(none)'}.` };
    }
    const next: Obj = { ...def };
    const left = list.filter((t) => t.id !== id);
    if (left.length) next.triggers = left; else delete next.triggers;
    const result = adopt(draftWrap, next, { ok: true, removed: id, note: 'Removed from the draft. A published app keeps running the trigger until it is published again.' });
    if (!result.error) result.triggers = readTriggers(draftWrap.def).map((t) => t.id);
    return result;
}

