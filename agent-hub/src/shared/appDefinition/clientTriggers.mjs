// @typecheck strict
/**
 * App Studio — the client triggers of schema 3, as plain data. Pure, imports nothing.
 *
 *   an event slot    `node.onClick` (any event), `screen.events.onOpen`: one action id, or
 *                    since schema 3 a list of up to MAX_ACTIONS_PER_EVENT ids that run one
 *                    after the other and stop at the first that fails. A list of one is
 *                    stored as the plain string, so every slot written before stays a string.
 *   screen.timers    [{ id, everySeconds, actionId }]: runs the action every N seconds while
 *                    the screen is open and the browser tab is visible.
 *   watchers         definition.watchers [{ id, expr, actionId, debounceMs? }]: runs the
 *                    action once each time the value of `expr` changes.
 *
 * Only a live run fires these: never the editor canvas, never the headless screenshot.
 * The canonicalizer, the validator, the run gate and the public surface on the server and
 * the runtime in the browser (a generated copy, see scripts/shared-mirror.manifest.json)
 * read the shapes through the helpers below.
 */

/** The bounds of the client triggers. Definition-validity limits: plain constants (componentSpecs/limits.js re-exports them). */
export const CLIENT_TRIGGER_LIMITS = Object.freeze({
    MAX_ACTIONS_PER_EVENT: 5,
    MIN_TIMER_SECONDS: 5,
    MAX_TIMER_SECONDS: 3600,
    MAX_SCREEN_TIMERS: 3,
    MAX_WATCHERS: 10,
    MAX_WATCHER_DEBOUNCE_MS: 10000,
    MAX_TRIGGER_ID_LEN: 40,
});

/** A watcher that runs more often than this within one minute is switched off for the rest of the visit. */
export const WATCHER_MAX_RUNS_PER_MINUTE = 10;

/** The events a screen fires (keys of `screen.events`). */
export const SCREEN_EVENT_NAMES = Object.freeze(['onOpen']);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The action ids an event slot names, in run order: [] for an empty or malformed slot.
 * @param {unknown} slot
 * @returns {string[]}
 */
export function slotActionIds(slot) {
    if (typeof slot === 'string') return slot ? [slot] : [];
    if (!Array.isArray(slot)) return [];
    return slot.filter((id) => typeof id === 'string' && id !== '');
}

/**
 * The slot value that stores `ids`: undefined for none, the plain string for one, the list otherwise.
 * @param {readonly string[]} ids
 * @returns {string | string[] | undefined}
 */
export function slotFromIds(ids) {
    const clean = ids.filter((id) => typeof id === 'string' && id !== '');
    if (!clean.length) return undefined;
    return clean.length === 1 ? clean[0] : clean.slice();
}

/**
 * True when `slot` names `actionId`.
 * @param {unknown} slot
 * @param {unknown} actionId
 */
export function slotNames(slot, actionId) {
    return typeof actionId === 'string' && actionId !== '' && slotActionIds(slot).includes(actionId);
}

/** @param {number} code */
function idChar(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 45;
}

/**
 * A timer or watcher id: letters, digits, `_` and `-`, starting with a letter, at most MAX_TRIGGER_ID_LEN.
 * Checked character by character (no pattern over author input).
 * @param {unknown} id
 * @returns {id is string}
 */
export function isTriggerId(id) {
    if (typeof id !== 'string' || !id || id.length > CLIENT_TRIGGER_LIMITS.MAX_TRIGGER_ID_LEN) return false;
    const first = id.charCodeAt(0);
    if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
    for (let i = 1; i < id.length; i++) if (!idChar(id.charCodeAt(i))) return false;
    return true;
}

/** The schema version a slot that holds a list of action ids needs. */
export const ACTION_LIST_SINCE = 3;

/**
 * True when a component event slot anywhere on the screens holds a list of action ids
 * (the schema 3 form). `eventNames` is the catalogue's EVENT_NAMES.
 * @param {unknown} definition
 * @param {readonly string[]} eventNames
 */
export function hasActionListSlot(definition, eventNames) {
    /** @param {unknown} node @param {number} depth @returns {boolean} */
    const visit = (node, depth) => {
        if (!isObject(node) || depth > 40) return false;
        if (eventNames.some((ev) => Array.isArray(node[ev]))) return true;
        return Array.isArray(node.children) && node.children.some((child) => visit(child, depth + 1));
    };
    const screens = isObject(definition) && Array.isArray(definition.screens) ? definition.screens : [];
    return screens.some((screen) => isObject(screen) && Array.isArray(screen.sections)
        && screen.sections.some((section) => isObject(section) && Array.isArray(section.children) && section.children.some((n) => visit(n, 0))));
}

/**
 * Every action a screen runs by itself (onOpen, its timers), in definition order, with where it hangs.
 * @param {unknown} screen
 * @returns {Array<{ actionId: string, via: string }>}
 */
export function screenTriggerRefs(screen) {
    if (!isObject(screen)) return [];
    /** @type {Array<{ actionId: string, via: string }>} */
    const out = [];
    if (isObject(screen.events)) {
        for (const event of SCREEN_EVENT_NAMES) {
            for (const actionId of slotActionIds(screen.events[event])) out.push({ actionId, via: `events.${event}` });
        }
    }
    if (Array.isArray(screen.timers)) {
        screen.timers.forEach((timer, i) => {
            if (isObject(timer) && typeof timer.actionId === 'string' && timer.actionId) out.push({ actionId: timer.actionId, via: `timers[${i}]` });
        });
    }
    return out;
}

/**
 * The watchers of a definition that are well formed enough to run.
 * @param {unknown} definition
 * @returns {Array<{ id: string, expr: string, actionId: string, debounceMs: number }>}
 */
export function watchersOf(definition) {
    const list = isObject(definition) && Array.isArray(definition.watchers) ? definition.watchers : [];
    /** @type {Array<{ id: string, expr: string, actionId: string, debounceMs: number }>} */
    const out = [];
    for (const w of list) {
        if (!isObject(w) || typeof w.expr !== 'string' || !w.expr || typeof w.actionId !== 'string' || !w.actionId) continue;
        const debounce = typeof w.debounceMs === 'number' && Number.isFinite(w.debounceMs) ? w.debounceMs : 0;
        out.push({
            id: typeof w.id === 'string' ? w.id : '',
            expr: w.expr,
            actionId: w.actionId,
            debounceMs: Math.min(Math.max(0, Math.floor(debounce)), CLIENT_TRIGGER_LIMITS.MAX_WATCHER_DEBOUNCE_MS),
        });
    }
    return out;
}

/**
 * The timers of a screen that are well formed enough to run, the interval clamped to the bounds.
 * @param {unknown} screen
 * @returns {Array<{ id: string, everySeconds: number, actionId: string }>}
 */
export function timersOf(screen) {
    const list = isObject(screen) && Array.isArray(screen.timers) ? screen.timers : [];
    /** @type {Array<{ id: string, everySeconds: number, actionId: string }>} */
    const out = [];
    for (const t of list) {
        if (!isObject(t) || typeof t.actionId !== 'string' || !t.actionId) continue;
        if (typeof t.everySeconds !== 'number' || !Number.isFinite(t.everySeconds)) continue;
        const seconds = Math.min(Math.max(Math.floor(t.everySeconds), CLIENT_TRIGGER_LIMITS.MIN_TIMER_SECONDS), CLIENT_TRIGGER_LIMITS.MAX_TIMER_SECONDS);
        out.push({ id: typeof t.id === 'string' ? t.id : '', everySeconds: seconds, actionId: t.actionId });
    }
    return out;
}
