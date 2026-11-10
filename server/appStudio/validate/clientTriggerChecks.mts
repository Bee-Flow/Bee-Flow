/**
 * App Studio validator — the client triggers of schema 3 (shared/appDefinition/clientTriggers.mjs):
 *
 *   checkActionList()      an event slot that holds a list of action ids (validate/nodeWiring.js
 *                          calls it for a node, checkScreenTriggers for a screen's onOpen)
 *   checkScreenTriggers()  screen.events and screen.timers of every screen
 *   validateWatchers()     definition.watchers (definitionKeys/watchers.js)
 *
 * A reference to an action that does not exist is an ERROR, like an unresolved onClick: the
 * canonicalizer removes such a reference, so it only reaches here from input that skipped it.
 */

import { createRequire } from 'node:module';
import { CLIENT_TRIGGER_LIMITS as L, SCREEN_EVENT_NAMES, isTriggerId } from '../../shared/appDefinition/clientTriggers.mjs';

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Push = (f: Finding) => void;
type Ctx = { pushE: Push; pushW: Push; actionIds?: Set<string> };
type Def = Record<string, unknown>;

const nodeRequire = createRequire(import.meta.url);
const { validateFormula } = nodeRequire('./formulas.js') as {
    validateFormula: (expr: unknown, path: string, ctx: unknown, roots?: string[]) => void;
};
const { pickClosestId } = nodeRequire('./shared.js') as { pickClosestId: (id: string, ids: string[]) => string | null };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function actionIdsOf(def: Def): Set<string> {
    return new Set(isObject(def.actions) ? Object.keys(def.actions) : []);
}

/** One action reference: an error when it names no action of the app. */
function checkActionRef(ref: unknown, path: string, label: string, ctx: Ctx, actionIds: Set<string>): void {
    if (typeof ref === 'string' && actionIds.has(ref)) return;
    const suggestion = pickClosestId(String(ref), [...actionIds]);
    ctx.pushE({
        code: 'event.action_unresolved', severity: 'error', path,
        message: `${label} references unknown action ${JSON.stringify(ref)}.`,
        hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the action to definition.actions first.',
    });
}

/** A slot holding a list: 2 to MAX_ACTIONS_PER_EVENT ids, each naming an action. */
export function checkActionList(list: unknown[], path: string, label: string, ctx: Ctx, actionIds: Set<string> = ctx.actionIds || new Set()): void {
    if (list.length < 1 || list.length > L.MAX_ACTIONS_PER_EVENT) {
        ctx.pushE({
            code: 'event.too_many_actions', severity: 'error', path,
            message: `${label} lists ${list.length} actions — an event runs 1 to ${L.MAX_ACTIONS_PER_EVENT}.`,
            hint: 'Keep the actions that must run in order, or combine them into one sequence action.',
        });
    }
    list.forEach((ref, i) => checkActionRef(ref, `${path}[${i}]`, label, ctx, actionIds));
}

function checkSlot(slot: unknown, path: string, label: string, ctx: Ctx, actionIds: Set<string>): void {
    if (Array.isArray(slot)) checkActionList(slot, path, label, ctx, actionIds);
    else checkActionRef(slot, path, label, ctx, actionIds);
}

function checkScreenEvents(events: unknown, path: string, ctx: Ctx, actionIds: Set<string>): void {
    if (!isObject(events)) {
        ctx.pushE({ code: 'screen.events_invalid', severity: 'error', path, message: 'screen.events must be an object { onOpen: actionId }.', hint: 'Run the definition through canonicalize.' });
        return;
    }
    for (const [event, slot] of Object.entries(events)) {
        if (!SCREEN_EVENT_NAMES.includes(event)) {
            ctx.pushE({ code: 'screen.event_unknown', severity: 'error', path: `${path}.${event}`, message: `A screen has no event "${event}".`, hint: `A screen fires ${SCREEN_EVENT_NAMES.join(', ')}.` });
            continue;
        }
        checkSlot(slot, `${path}.${event}`, event, ctx, actionIds);
    }
}

/** An id that is well formed and not used twice in its list. */
function checkTriggerId(id: unknown, path: string, seen: Set<string>, ctx: Ctx): void {
    if (isTriggerId(id) && !seen.has(id)) {
        seen.add(id);
        return;
    }
    ctx.pushE({
        code: 'trigger.id_invalid', severity: 'error', path,
        message: `Id ${JSON.stringify(id)} is missing, malformed or used twice.`,
        hint: `A letter, then letters, digits, _ or -, at most ${L.MAX_TRIGGER_ID_LEN} characters, unique in the list.`,
    });
}

function checkTimers(timers: unknown, path: string, ctx: Ctx, actionIds: Set<string>): void {
    if (!Array.isArray(timers) || timers.length > L.MAX_SCREEN_TIMERS) {
        ctx.pushE({ code: 'screen.timers_invalid', severity: 'error', path, message: `screen.timers must be a list of at most ${L.MAX_SCREEN_TIMERS} { id, everySeconds, actionId }.`, hint: 'Run the definition through canonicalize.' });
        return;
    }
    const seen = new Set<string>();
    timers.forEach((timer, i) => {
        const at = `${path}[${i}]`;
        const t = isObject(timer) ? timer : {};
        checkTriggerId(t.id, `${at}.id`, seen, ctx);
        const every = t.everySeconds;
        if (typeof every !== 'number' || !Number.isInteger(every) || every < L.MIN_TIMER_SECONDS || every > L.MAX_TIMER_SECONDS) {
            ctx.pushE({ code: 'screen.timer_interval', severity: 'error', path: `${at}.everySeconds`, message: `everySeconds must be a whole number from ${L.MIN_TIMER_SECONDS} to ${L.MAX_TIMER_SECONDS}.`, hint: 'A timer shorter than 5 seconds would flood the server.' });
        }
        checkActionRef(t.actionId, `${at}.actionId`, 'A timer', ctx, actionIds);
    });
}

/** screen.events and screen.timers of every screen that carries them. */
export function checkScreenTriggers(def: Def, ctx: Ctx): void {
    const screens = Array.isArray(def.screens) ? def.screens : [];
    const actionIds = actionIdsOf(def);
    screens.forEach((screen, i) => {
        if (!isObject(screen)) return;
        if (screen.events !== undefined) checkScreenEvents(screen.events, `screens[${i}].events`, ctx, actionIds);
        if (screen.timers !== undefined) checkTimers(screen.timers, `screens[${i}].timers`, ctx, actionIds);
    });
}

function checkWatcher(raw: unknown, at: string, seen: Set<string>, ctx: Ctx & { def: Def }, actionIds: Set<string>): void {
    const w = isObject(raw) ? raw : {};
    checkTriggerId(w.id, `${at}.id`, seen, ctx);
    validateFormula(w.expr, `${at}.expr`, ctx);
    checkActionRef(w.actionId, `${at}.actionId`, 'A watcher', ctx, actionIds);
    const ms = w.debounceMs;
    if (ms !== undefined && (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > L.MAX_WATCHER_DEBOUNCE_MS)) {
        ctx.pushE({ code: 'watcher.debounce_invalid', severity: 'error', path: `${at}.debounceMs`, message: `debounceMs must be a whole number from 0 to ${L.MAX_WATCHER_DEBOUNCE_MS}.`, hint: 'Leave it out to run right after the change.' });
    }
}

/** definition.watchers: a list of at most MAX_WATCHERS well-formed watchers. */
export function validateWatchers(value: unknown, ctx: Ctx & { def: Def }): void {
    if (!Array.isArray(value) || value.length > L.MAX_WATCHERS) {
        ctx.pushE({ code: 'watchers.invalid', severity: 'error', path: 'watchers', message: `watchers must be a list of at most ${L.MAX_WATCHERS} { id, expr, actionId, debounceMs? }.`, hint: 'Run the definition through canonicalize.' });
        return;
    }
    const seen = new Set<string>();
    const actionIds = actionIdsOf(ctx.def);
    value.forEach((raw, i) => checkWatcher(raw, `watchers[${i}]`, seen, ctx, actionIds));
}
