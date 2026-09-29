// @typecheck
/**
 * The agent's own to-do list for a build — the shape both builders' route-
 * handled plan tools (builder_set_plan, app_set_plan) read and write, and the
 * echo the model gets back. Kept out of the routes so the list form, the
 * markDone diff form and the caps cannot drift between the two builders.
 *
 * `todos` is [{ text, done }]. The echo carries 0-based indices because the
 * markDone form takes them; without `i` the model re-derived the plan from
 * the user's message every round.
 */

'use strict';

const MAX_TODOS = 30;
const MAX_TODO_CHARS = 200;

/** Sanitise an agent-supplied to-do list (capped; {text, done}). */
function normalizePlanTodos(todos) {
    if (!Array.isArray(todos)) return [];
    return todos
        .filter(t => t && (typeof t === 'string' || typeof t.text === 'string'))
        .slice(0, MAX_TODOS)
        .map(t => (typeof t === 'string'
            ? { text: t.slice(0, MAX_TODO_CHARS), done: false }
            : { text: String(t.text).slice(0, MAX_TODO_CHARS), done: !!t.done }));
}

/**
 * A full list sent again → the plan the loop already has, with its `done`
 * flags kept. Measured 2026-09-13: the small model re-sent its six todos
 * verbatim mid-build and the route REPLACED the list, resetting every tick.
 * Items are matched by text (trimmed, case-blind): an item of `next` is done
 * when `next` says so OR the previous list had it done; `unchanged` is true
 * when both lists carry the same texts in the same order. Pure.
 * @returns {{ todos: Array<{text:string,done:boolean}>, unchanged: boolean }}
 */
function mergePlanTodos(prev, next) {
    const before = normalizePlanTodos(prev);
    const after = normalizePlanTodos(next);
    const key = (t) => String(t.text || '').trim().toLowerCase();
    const doneBefore = new Set(before.filter(t => t.done).map(key));
    const todos = after.map(t => ({ text: t.text, done: t.done || doneBefore.has(key(t)) }));
    const unchanged = before.length === after.length && before.every((t, i) => key(t) === key(after[i]));
    return { todos: unchanged ? before : todos, unchanged };
}

/**
 * Mark items done given 0-based indices of the existing list. Out-of-range /
 * non-integer entries are ignored; the input array is not mutated.
 */
function applyPlanMarkDone(todos, indices) {
    const base = Array.isArray(todos) ? todos.map(t => ({ ...t })) : [];
    if (!Array.isArray(indices)) return base;
    for (const i of indices) {
        if (Number.isInteger(i) && i >= 0 && i < base.length) base[i].done = true;
    }
    return base;
}

/** The tool result the model reads back: the list with indices, and what is next. */
function planEcho(todos) {
    const list = Array.isArray(todos) ? todos : [];
    return {
        ok: true,
        todos: list.map((t, i) => ({ i, text: t.text, done: !!t.done })),
        next: (list.find(t => !t.done) || {}).text || null,
    };
}

// ── Fuzzy matching of a tool call against the to-do wording ────────────────
// A to-do like "Add the Facturen table" should tick when the model links a
// table named Facturen, without the model calling markDone. Token overlap
// over lowercase alphanumerics with the caller's stop words dropped; light
// stemming (trailing s) so "files" meets "file". Two shared significant
// tokens are required, always: one shared word ("file") would let a LIST step
// tick a READ item. Which tool evidences which words is each builder's own
// rule set (routes/ai/<builder>/planProgress.js); this is the arithmetic.

const DEFAULT_STOP = new Set([
    'the', 'and', 'for', 'each', 'with', 'into', 'from', 'via', 'per', 'all', 'then', 'that', 'this', 'its',
    'step', 'steps', 'add', 'added', 'create', 'set', 'use', 'using', 'new', 'one',
    'een', 'het', 'van', 'voor', 'met', 'naar', 'uit', 'bij', 'maak', 'voeg', 'toe', 'zet', 'nieuwe',
]);

function makeTokenizer(stop = DEFAULT_STOP) {
    const tokens = (text) => new Set(
        String(text || '')
            .toLowerCase()
            .split(/[^a-z0-9à-ÿ]+/)
            .map(t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t))
            .filter(t => t.length >= 2 && !stop.has(t) && !/^\d+$/.test(t)),
    );
    const overlap = (a, b) => {
        let n = 0;
        for (const t of a) if (b.has(t)) n++;
        return n;
    };
    const matchesItem = (itemText, evidence, min = 2) => {
        const it = tokens(itemText);
        if (!it.size) return false;
        return overlap(it, evidence) >= min;
    };
    return { tokens, overlap, matchesItem };
}

module.exports = {
    MAX_TODOS,
    MAX_TODO_CHARS,
    normalizePlanTodos,
    mergePlanTodos,
    applyPlanMarkDone,
    planEcho,
    DEFAULT_STOP,
    makeTokenizer,
};
