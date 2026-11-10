// @typecheck strict
/**
 * App Studio canonicalizer — the client triggers of schema 3 (shapes and bounds in
 * shared/appDefinition/clientTriggers.mjs):
 *
 *   canonActionSlot()          one event slot: an action id, or a list of up to
 *                              MAX_ACTIONS_PER_EVENT ids. A list of one becomes the plain
 *                              string, so a slot that held one id keeps its bytes.
 *   SCREEN_TRIGGER_CLEANERS    `screen.events` and `screen.timers`, emit-when-present
 *                              (emitOptionalKeys): an absent key stays absent.
 *   cleanWatchers()            `definition.watchers` (definitionKeys/watchers.js).
 *   resolveTriggerRefs()       pass 2: rewrite renamed action ids and drop the ones that
 *                              name no action, in every slot list and screen trigger.
 *
 * Ids of timers and watchers are not minted at random (that would make a second pass
 * change the bytes): a missing or malformed id becomes `timer1`, `watch2`, … by position.
 */

'use strict';

const { LIMITS } = require('../componentSpecs/limits');
const {
    SCREEN_EVENT_NAMES, isTriggerId, slotActionIds, slotFromIds,
} = require('../../shared/appDefinition/clientTriggers.mjs');
const { isObject, truncate } = require('./shared');

/** @typedef {(code: string, path: string, message: string) => void} Push */

/**
 * One event slot as stored: a non-empty string, or a list of 2 to MAX_ACTIONS_PER_EVENT
 * non-empty strings. Anything else is dropped with a repair.
 * @param {unknown} raw
 * @param {string} path
 * @param {Push} push
 * @param {string} name  the slot's name, for the message
 * @returns {string | string[] | undefined}
 */
function canonActionSlot(raw, path, push, name) {
    if (typeof raw === 'string' && raw) return raw;
    if (!Array.isArray(raw)) {
        push('event.invalid', path, `${name} must be an action id string — dropped.`);
        return undefined;
    }
    const ids = slotActionIds(raw);
    if (ids.length !== raw.length) push('event.invalid', path, `${name}: entries that are not action id strings were dropped.`);
    if (ids.length > LIMITS.MAX_ACTIONS_PER_EVENT) {
        push('event.too_many_actions', path, `${name} lists ${ids.length} actions — kept the first ${LIMITS.MAX_ACTIONS_PER_EVENT}.`);
        ids.length = LIMITS.MAX_ACTIONS_PER_EVENT;
    }
    const slot = slotFromIds(ids);
    if (slot === undefined) push('event.invalid', path, `${name} lists no action id — dropped.`);
    return slot;
}

/**
 * `screen.events`: `{ onOpen: slot }`. An unknown event name is dropped with a repair; an
 * object with nothing left is left out.
 * @param {unknown} value
 * @param {string} path
 * @param {Push} push
 */
function cleanScreenEvents(value, path, push) {
    if (!isObject(value)) {
        push('screen.events_invalid', path, 'screen.events must be an object { onOpen: actionId } — dropped.');
        return undefined;
    }
    /** @type {Record<string, string | string[]>} */
    const out = {};
    for (const [event, slot] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
        if (!SCREEN_EVENT_NAMES.includes(event)) {
            push('screen.events_invalid', `${path}.${event}`, `A screen fires ${SCREEN_EVENT_NAMES.join(', ')}; "${event}" was dropped.`);
            continue;
        }
        if (slot === undefined || slot === null) continue;
        const cleaned = canonActionSlot(slot, `${path}.${event}`, push, event);
        if (cleaned !== undefined) out[event] = cleaned;
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * An id kept when it is well formed and unused, else `<prefix><n>` by position.
 * @param {unknown} raw
 * @param {{ prefix: string, index: number, path: string }} at
 * @param {{ taken: Set<string>, push: Push }} ids
 */
function triggerId(raw, { prefix, index, path }, { taken, push }) {
    if (isTriggerId(raw) && !taken.has(raw)) {
        taken.add(raw);
        return raw;
    }
    let n = index + 1;
    while (taken.has(`${prefix}${n}`)) n++;
    const id = `${prefix}${n}`;
    taken.add(id);
    push('trigger.id_generated', path, `${raw === undefined ? 'Missing' : 'Invalid or duplicate'} id — set to "${id}".`);
    return id;
}

/**
 * One whole number in [min, max], or undefined (with a repair) for anything else.
 * @param {unknown} raw
 * @param {number} min
 * @param {number} max
 * @param {string} path
 * @param {Push} push
 */
function boundedInt(raw, min, max, path, push) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        push('trigger.number_invalid', path, `Must be a number from ${min} to ${max} — the entry was dropped.`);
        return undefined;
    }
    const n = Math.round(raw);
    const clamped = Math.min(Math.max(n, min), max);
    if (clamped !== raw) push('trigger.number_clamped', path, `${raw} is outside ${min} to ${max} — set to ${clamped}.`);
    return clamped;
}

/**
 * `screen.timers`: `[{ id, everySeconds, actionId }]`, at most MAX_SCREEN_TIMERS.
 * @param {unknown} value
 * @param {string} path
 * @param {Push} push
 */
function cleanScreenTimers(value, path, push) {
    if (!Array.isArray(value)) {
        push('screen.timers_invalid', path, 'screen.timers must be a list of { id, everySeconds, actionId } — dropped.');
        return undefined;
    }
    let list = value;
    if (list.length > LIMITS.MAX_SCREEN_TIMERS) {
        push('screen.timers_truncated', path, `A screen has at most ${LIMITS.MAX_SCREEN_TIMERS} timers — kept the first ${LIMITS.MAX_SCREEN_TIMERS}.`);
        list = list.slice(0, LIMITS.MAX_SCREEN_TIMERS);
    }
    const taken = new Set();
    /** @type {Array<{ id: string, everySeconds: number, actionId: string }>} */
    const out = [];
    list.forEach((raw, i) => {
        const at = `${path}[${i}]`;
        if (!isObject(raw) || typeof raw.actionId !== 'string' || !raw.actionId) {
            push('screen.timers_invalid', at, 'A timer needs { everySeconds, actionId } — dropped.');
            return;
        }
        const everySeconds = boundedInt(raw.everySeconds, LIMITS.MIN_TIMER_SECONDS, LIMITS.MAX_TIMER_SECONDS, `${at}.everySeconds`, push);
        if (everySeconds === undefined) return;
        out.push({ id: triggerId(raw.id, { prefix: 'timer', index: i, path: `${at}.id` }, { taken, push }), everySeconds, actionId: raw.actionId });
    });
    return out.length ? out : undefined;
}

/**
 * `definition.watchers`: `[{ id, expr, actionId, debounceMs? }]`, at most MAX_WATCHERS.
 * `debounceMs` is written only when it is above 0 (0 is what an absent one means).
 * @param {unknown} value
 * @param {Push} push
 */
function cleanWatchers(value, push) {
    const path = 'watchers';
    if (!Array.isArray(value)) {
        push('watchers.invalid', path, 'watchers must be a list of { id, expr, actionId, debounceMs? } — dropped.');
        return undefined;
    }
    let list = value;
    if (list.length > LIMITS.MAX_WATCHERS) {
        push('watchers.truncated', path, `An app has at most ${LIMITS.MAX_WATCHERS} watchers — kept the first ${LIMITS.MAX_WATCHERS}.`);
        list = list.slice(0, LIMITS.MAX_WATCHERS);
    }
    const taken = new Set();
    /** @type {Array<Record<string, unknown>>} */
    const out = [];
    list.forEach((raw, i) => {
        const at = `${path}[${i}]`;
        if (!isObject(raw) || typeof raw.expr !== 'string' || !raw.expr.trim() || typeof raw.actionId !== 'string' || !raw.actionId) {
            push('watchers.invalid', at, 'A watcher needs { expr, actionId } — dropped.');
            return;
        }
        /** @type {Record<string, unknown>} */
        const entry = {
            id: triggerId(raw.id, { prefix: 'watch', index: i, path: `${at}.id` }, { taken, push }),
            expr: truncate(raw.expr.trim(), LIMITS.MAX_FORMULA_LEN, `${at}.expr`, push),
            actionId: raw.actionId,
        };
        if (raw.debounceMs !== undefined && raw.debounceMs !== null) {
            const ms = boundedInt(raw.debounceMs, 0, LIMITS.MAX_WATCHER_DEBOUNCE_MS, `${at}.debounceMs`, push);
            if (ms) entry.debounceMs = ms;
        }
        out.push(entry);
    });
    return out.length ? out : undefined;
}

/**
 * The cleaners of the two screen keys, in the order they are written (after `sections`).
 * @type {Readonly<Record<string, import('./shared').OptionalKeyCleaner>>}
 */
const SCREEN_TRIGGER_CLEANERS = Object.freeze({
    events: cleanScreenEvents,
    timers: cleanScreenTimers,
});

/**
 * @typedef {{ rename: (id: string) => string, actionIds: Set<string>, push: Push }} SlotRefs
 *   what pass 2 resolves a slot against
 */

/**
 * Pass 2 over one event slot: rename, drop ids that name no action, store the rest the
 * canonical way. Returns undefined when nothing is left.
 * @param {unknown} slot
 * @param {string} path
 * @param {string} name
 * @param {SlotRefs} refs
 */
function resolveSlot(slot, path, name, { rename, actionIds, push }) {
    const kept = [];
    for (const raw of slotActionIds(slot)) {
        const id = rename(raw);
        if (actionIds.has(id)) kept.push(id);
        else push('event.dangling', path, `${name} referenced unknown action "${raw}" — removed. Add the action first, then wire the event.`);
    }
    return slotFromIds(kept);
}

/**
 * Pass 2 over the screen triggers of a rebuilt definition (the node slots that hold a list
 * go through resolveSlot from canonicalize/references.js). Mutates the rebuilt screens.
 * @param {{ screens: Array<Record<string, any>> }} def
 * @param {SlotRefs} refs
 */
function resolveScreenTriggerRefs(def, refs) {
    const { rename, actionIds, push } = refs;
    def.screens.forEach((screen, si) => {
        const at = `screens[${si}]`;
        if (isObject(screen.events)) {
            for (const event of Object.keys(screen.events)) {
                const slot = resolveSlot(screen.events[event], `${at}.events.${event}`, event, refs);
                if (slot === undefined) delete screen.events[event];
                else screen.events[event] = slot;
            }
            if (!Object.keys(screen.events).length) delete screen.events;
        }
        if (Array.isArray(screen.timers)) {
            const timers = screen.timers.filter((timer, ti) => {
                timer.actionId = rename(timer.actionId);
                if (actionIds.has(timer.actionId)) return true;
                push('event.dangling', `${at}.timers[${ti}].actionId`, `A timer referenced unknown action "${timer.actionId}" — the timer was removed.`);
                return false;
            });
            if (timers.length) screen.timers = timers;
            else delete screen.timers;
        }
    });
}

module.exports = {
    canonActionSlot,
    cleanScreenEvents,
    cleanScreenTimers,
    cleanWatchers,
    SCREEN_TRIGGER_CLEANERS,
    resolveSlot,
    resolveScreenTriggerRefs,
};
