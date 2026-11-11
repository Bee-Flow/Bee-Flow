/**
 * `definition.triggers` (schema 3): its canonical form, its validation, and the fingerprint an
 * armed trigger is compared with.
 *
 *   [{ id, kind, actionId, enabled?, …the fields of its kind }]
 *
 * `enabled` is only written as `false` (the trigger stays in the app but is not armed at a
 * publish); absent means on. An absent `triggers` key stays absent, so an app without triggers
 * keeps its bytes and its schema version.
 *
 * A trigger in a definition does nothing by itself. It is armed when the app is PUBLISHED
 * (triggerSync.mts), from the published copy only.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeOverCalls, ownAction } from '../actionCalls.mts';
import { ENVELOPE_FIELDS, triggerKind, triggerKinds } from './triggerKinds.mts';
import type { Finding, Obj, Push, TriggerKind } from './triggerKinds.mts';
import { unattendedActionProblems } from './unattendedPolicy.mts';

const nodeRequire = createRequire(import.meta.url);
const { isTriggerId } = nodeRequire('../../shared/appDefinition/clientTriggers.mjs') as { isTriggerId: (id: unknown) => id is string };

/** Triggers in one app. A limit of the definition, the same on every install. */
export const MAX_TRIGGERS = 20;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export type AppTrigger = Obj & { id: string; kind: string; actionId: string; enabled?: false };
export type CanonContext = { renameMap: unknown; actionIds?: Set<string> };
export type ValidateContext = { def: Obj; pushE: (f: Finding) => void; pushW: (f: Finding) => void };

const kindNames = (): string => triggerKinds().map((k) => k.kind).join(', ');

/** A missing, malformed or repeated id becomes `trigger<n>` by position (never random: a second pass keeps the bytes). */
function canonId(raw: unknown, index: number, at: string, taken: Set<string>, push: Push): string {
    if (isTriggerId(raw) && !taken.has(raw)) {
        taken.add(raw);
        return raw;
    }
    let n = index + 1;
    while (taken.has(`trigger${n}`)) n += 1;
    const id = `trigger${n}`;
    taken.add(id);
    push('triggers.id_repaired', `${at}.id`, `Trigger id ${JSON.stringify(raw ?? null)} is missing, malformed or used twice — it became "${id}".`);
    return id;
}

function canonOne(raw: unknown, index: number, taken: Set<string>, push: Push, ctx: CanonContext): AppTrigger | null {
    const at = `triggers[${index}]`;
    if (!isObject(raw) || typeof raw.actionId !== 'string' || !raw.actionId) {
        push('triggers.invalid', at, 'A trigger needs { kind, actionId } — it was removed.');
        return null;
    }
    const kind = triggerKind(raw.kind);
    if (!kind) {
        push('triggers.kind_unknown', `${at}.kind`, `Unknown trigger kind ${JSON.stringify(raw.kind ?? null)} (known: ${kindNames()}) — the trigger was removed.`);
        return null;
    }
    const renames = ctx.renameMap instanceof Map ? ctx.renameMap : new Map();
    const actionId = String(renames.get(raw.actionId) || raw.actionId);
    if (ctx.actionIds && !ctx.actionIds.has(actionId)) {
        push('event.dangling', `${at}.actionId`, `A trigger referenced unknown action "${raw.actionId}" — the trigger was removed.`);
        return null;
    }
    const own = kind.canon(raw, at, push);
    if (!own) return null;
    const out: AppTrigger = { id: canonId(raw.id, index, at, taken, push), kind: kind.kind, actionId, ...own };
    if (raw.enabled === false) out.enabled = false;
    return out;
}

/** The canonical list, or undefined when nothing is left (the key is then not written). */
export function canonTriggers(value: unknown, push: Push, ctx: CanonContext): AppTrigger[] | undefined {
    if (!Array.isArray(value)) {
        push('triggers.invalid', 'triggers', 'triggers must be a list of { id, kind, actionId, … } — dropped.');
        return undefined;
    }
    let list = value;
    if (list.length > MAX_TRIGGERS) {
        push('triggers.truncated', 'triggers', `An app has at most ${MAX_TRIGGERS} triggers — kept the first ${MAX_TRIGGERS}.`);
        list = list.slice(0, MAX_TRIGGERS);
    }
    const taken = new Set<string>();
    const out: AppTrigger[] = [];
    list.forEach((raw, i) => {
        const one = canonOne(raw, i, taken, push, ctx);
        if (one) out.push(one);
    });
    return out.length ? out : undefined;
}

function checkEnvelope(t: Obj, at: string, seen: Set<string>, kind: TriggerKind | null, ctx: ValidateContext): void {
    if (!isTriggerId(t.id) || seen.has(t.id)) {
        ctx.pushE({ code: 'triggers.id_invalid', severity: 'error', path: `${at}.id`, message: `Trigger id ${JSON.stringify(t.id ?? null)} is missing, malformed or used twice.`, hint: 'A letter, then letters, digits, _ or -, at most 40 characters, unique in the list.' });
    } else {
        seen.add(t.id);
    }
    if (t.enabled !== undefined && t.enabled !== false) {
        ctx.pushE({ code: 'triggers.enabled_invalid', severity: 'error', path: `${at}.enabled`, message: 'enabled is only written as false; leave it out for a trigger that is on.', hint: 'Remove the key, or set it to false.' });
    }
    if (!kind) return;
    const known = new Set([...ENVELOPE_FIELDS, ...kind.fields]);
    for (const key of Object.keys(t)) {
        if (!known.has(key)) ctx.pushE({ code: 'triggers.field_unknown', severity: 'error', path: `${at}.${key}`, message: `A ${kind.kind} trigger has no field "${key}".`, hint: `Its fields: ${[...known].join(', ')}.` });
    }
}

/** The action a trigger starts: it exists and every step of it may run without a person. */
function checkAction(t: Obj, at: string, kind: TriggerKind | null, ctx: ValidateContext): void {
    const actions = ctx.def.actions;
    const action = ownAction(actions, t.actionId);
    if (!action) {
        ctx.pushE({ code: 'event.action_unresolved', severity: 'error', path: `${at}.actionId`, message: `A trigger references unknown action ${JSON.stringify(t.actionId ?? null)}.`, hint: 'Add the action to definition.actions first.' });
        return;
    }
    const problems = unattendedActionProblems(action, String(t.actionId), { resolveCalled: (id) => ownAction(actions, id), refusedKinds: kind?.refusedKinds });
    for (const p of problems) {
        ctx.pushE({ code: p.code, severity: 'error', path: `actions.${String(t.actionId)}${p.path ? `.${p.path}` : ''}`, message: p.message, hint: p.hint });
    }
}

/** The validator's findings for `definition.triggers`. */
export function validateTriggers(value: unknown, ctx: ValidateContext): void {
    if (!Array.isArray(value) || value.length > MAX_TRIGGERS) {
        ctx.pushE({ code: 'triggers.invalid', severity: 'error', path: 'triggers', message: `triggers must be a list of at most ${MAX_TRIGGERS} { id, kind, actionId, … }.`, hint: 'Run the definition through canonicalize.' });
        return;
    }
    const seen = new Set<string>();
    value.forEach((t, i) => {
        const at = `triggers[${i}]`;
        if (!isObject(t)) {
            ctx.pushE({ code: 'triggers.invalid', severity: 'error', path: at, message: 'A trigger is an object { id, kind, actionId, … }.', hint: 'Run the definition through canonicalize.' });
            return;
        }
        const kind = triggerKind(t.kind);
        if (!kind) ctx.pushE({ code: 'triggers.kind_unknown', severity: 'error', path: `${at}.kind`, message: `Unknown trigger kind ${JSON.stringify(t.kind ?? null)}.`, hint: `Known kinds: ${kindNames()}.` });
        checkEnvelope(t, at, seen, kind, ctx);
        if (kind) kind.validate(t, at, ctx);
        checkAction(t, at, kind, ctx);
    });
}

/** The triggers of a definition as stored (a malformed key reads as none). */
export function readTriggers(def: unknown): AppTrigger[] {
    const list = isObject(def) && Array.isArray(def.triggers) ? def.triggers : [];
    return list.filter((t): t is AppTrigger => isObject(t) && typeof t.id === 'string' && typeof t.kind === 'string' && typeof t.actionId === 'string');
}

/** JSON with the keys of every object in order: two equal values give the same text. */
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (!isObject(value)) return JSON.stringify(value ?? null);
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

/**
 * What an armed trigger is: its kind, its own fields, the action it starts and every action that
 * one calls, as one hash. The armed row keeps it; a fire compares it with the published
 * definition of that moment, so a trigger never runs something other than what was published
 * with it.
 */
export function triggerFingerprint(def: Obj, trigger: AppTrigger): string {
    const kind = triggerKind(trigger.kind);
    const hash = createHash('sha256');
    hash.update(`${stableJson({ kind: trigger.kind, actionId: trigger.actionId, config: kind ? kind.config(trigger) : null })}\n`);
    for (const id of [...closeOverCalls(def.actions, [trigger.actionId])].sort()) hash.update(`${JSON.stringify(id)}:${stableJson(ownAction(def.actions, id))}\n`);
    return hash.digest('hex');
}
