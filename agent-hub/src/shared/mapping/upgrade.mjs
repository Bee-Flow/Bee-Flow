/**
 * Lifting a legacy binding to a pick, for display.
 *
 * A stored automation keeps its refs and exprs as they are: nothing here
 * rewrites a definition. The editor asks liftLegacy whether a legacy binding
 * can be SHOWN as a chip; when it can, the chip is the pick it lifts to, and
 * the binding is only rewritten (to that pick) when the user changes the
 * field, with the new result previewed first. When it cannot, the answer is
 * null and the field shows the grey "Formula" chip, which keeps the binding
 * exactly as stored.
 *
 *   ref without [*]                      → pick take 'one', as 'native'
 *   ref with [*]                         → pick take 'all', as 'native'
 *   join(p, "\n") / join(p, ", ")        → pick take 'all', as 'text', join lines / comma
 *   first(p) / last(p) / count(p)        → pick take 'first' / 'last' / 'count', as 'native'
 *   anything else                        → null ("Formula")
 *
 * A lift is a claim that the chip gives what the run gives today, so it is
 * checked against the data at hand: the design-time sample and, when there
 * is one, the last real run (both runState-shaped: `{ trigger: { output },
 * steps: { <id>: { output } }, vars, loop }`). In each of them the lifted pick
 * must resolve to what the legacy binding resolves to (deep equality). The one
 * difference allowed is a legacy value that was undefined: a ref the old
 * walker could not read (a key on a list, a path into a JSON text) gets a
 * value from a pick, which is the repair M2 made on purpose.
 *
 * A plain ref of keys only needs no evidence: one without [*] or an index
 * reads what a pick of the same Source reads, whatever the data. An index
 * does not: on a text the legacy walker reads a character (`note[0]` of
 * 'abc' is 'a', `body[0]` of a JSON text is '['), where a pick reads nothing
 * or indexes the parsed JSON. A [*] ref and the four functions do not either
 * (a nested list flattens differently, count() of a text is its length,
 * join() writes a record as "Key: value" pairs). These lift only when at
 * least one of the given runStates actually holds data under the path and
 * every comparison agrees. No data, no lift: the chip would be a guess.
 *
 * The expression engine is injected (as in resolve.mjs, since this directory
 * is copied to the clients): without `evaluate`, no expr lifts.
 *
 * Templates are not lifted here. How a `{{ }}` renders depends on the field
 * (leaveUnresolved in prompts, listAsMarkdown on form pages), so lifting one
 * to a compose belongs to the text-field editor that knows the field.
 *
 * The one writer that does rewrite a stored definition is the opt-in action
 * at the end of this file (M8, upgradeDefinition): its owner asks for it,
 * sees a dry run, and every binding whose value would change stays as it is.
 */

import { REF_RE, tokenizePath, walkPath } from './legacy.mjs';
import { REFUSED_KEYS, manyItems, walkSource } from './walk.mjs';
import { MAPPING_VERSION, sourceFromPath } from './intent.mjs';
import { isCompose, isPick } from './validate.mjs';
import { createResolver } from './resolve.mjs';
import { fieldValue, stepBindingSites } from './sites.mjs';
import { REPEAT_DEFAULT_MAX, REPEAT_MAX, clone, readsLoopItem, rebaseLoopRefs, setField } from './repeat.mjs';
import { labelParts, labelText } from './label.mjs';

/** The functions an expr may call to lift, with the take each one is. */
const FUNCTION_TAKES = Object.freeze({ first: 'first', last: 'last', count: 'count', join: 'all' });

/** The join() separators that have a pick equivalent. */
const JOIN_SEPARATORS = Object.freeze({ '\n': 'lines', ', ': 'comma' });

// One call of a liftable function on one argument path, with an optional
// quoted separator: `join(steps.s1.output.items[*].name, ", ")`. The path
// itself is checked with REF_RE below; this only splits the call.
const CALL_RE = /^\s*([A-Za-z]+)\s*\(\s*([^,()"']+?)\s*(?:,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\s*\)\s*$/;

function noEvaluate() {
    throw new Error('no expression engine');
}

/** The separator a quoted expr string literal holds, or null for one we do not read. */
function unquote(literal) {
    if (typeof literal !== 'string' || literal.length < 2) return null;
    const body = literal.slice(1, -1);
    // Only the escapes a separator uses; anything else is not liftable.
    if (/\\[^n\\"']/.test(body)) return null;
    return body.replace(/\\(n|\\|"|')/g, (_, c) => (c === 'n' ? '\n' : c));
}

/**
 * The tokens of a legacy ref path that a pick can read the same way, or null.
 * Refused: a path REF_RE rejects (the run reads nothing there, and a chip
 * would claim it does), a key the v2 walk never reads (`length`, …), and an
 * index after a `[*]` (`items[*][0]` indexes each item; the pick would index
 * the list).
 */
function liftableTokens(path) {
    if (typeof path !== 'string' || !REF_RE.test(path)) return null;
    const tokens = tokenizePath(path);
    if (!tokens) return null;
    let wild = false;
    for (const tok of tokens) {
        if (tok.type === 'wild') { wild = true; continue; }
        if (typeof tok.key === 'string' && REFUSED_KEYS.includes(tok.key)) return null;
        if (wild && typeof tok.key === 'number') return null;
    }
    return { tokens, wild };
}

function pickOf(path, intent) {
    const from = sourceFromPath(path);
    if (!from) return null;
    const pick = { kind: 'pick', v: MAPPING_VERSION, from, ...intent };
    return isPick(pick) ? pick : null;
}

function isEmptyData(value) {
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/** Structural equality of plain run data (JSON values, undefined included). */
function sameValue(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}

/**
 * The pick a legacy binding would lift to, before any data is looked at:
 * `{ pick, argPath, needsEvidence }`, or null when it is a Formula whatever
 * the data holds.
 */
function liftCandidate(binding, evaluate) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
    let pick = null;
    let argPath = null;
    let needsEvidence = false;
    if (binding.kind === 'ref') {
        const lift = liftableTokens(binding.path);
        if (!lift) return null;
        pick = pickOf(binding.path, { take: lift.wild ? 'all' : 'one', as: 'native' });
        argPath = binding.path;
        // An index may land on a text, which the two walkers read differently.
        needsEvidence = lift.wild || lift.tokens.some(t => typeof t.key === 'number');
    } else if (binding.kind === 'expr') {
        if (typeof evaluate !== 'function' || typeof binding.value !== 'string') return null;
        const m = CALL_RE.exec(binding.value);
        if (!m || !Object.prototype.hasOwnProperty.call(FUNCTION_TAKES, m[1])) return null;
        const [, fn, path, sepLiteral] = m;
        if (!liftableTokens(path)) return null;
        if (fn === 'join') {
            const join = JOIN_SEPARATORS[unquote(sepLiteral)];
            if (!join) return null;
            pick = pickOf(path, { take: 'all', as: 'text', join });
        } else {
            if (sepLiteral !== undefined) return null;
            pick = pickOf(path, { take: FUNCTION_TAKES[fn], as: 'native' });
        }
        argPath = path;
        needsEvidence = true;
    }
    return pick ? { pick, argPath, needsEvidence } : null;
}

/**
 * A candidate checked against the data: `{ pick }`, or `{ reason }` with
 * 'formula' (no pick reads it), 'would_change' (a runState where the two
 * resolve differently) or 'no_evidence' (a lift that needs data and found
 * none). `strict` is for rewriting a stored definition: a value the legacy
 * binding did not have is a change (liftLegacy allows it, the repair of M2),
 * and every lift needs data, a runState where the legacy binding gave a
 * value, since a ref of plain keys too reads differently from its pick
 * where it meets a list or a JSON text.
 */
function checkLift(binding, states, resolver, evaluate, strict) {
    const cand = liftCandidate(binding, evaluate);
    if (!cand) return { reason: 'formula' };
    let evidence = false;
    let defined = false;
    for (const state of states) {
        const before = resolver.resolveValue(binding, state, { silent: true });
        const after = resolver.resolveValue(cand.pick, state, { silent: true });
        if (!isEmptyData(walkPath(cand.argPath, state))) evidence = true;
        if (before !== undefined) defined = true;
        if (before === undefined && !cand.needsEvidence && !strict) continue;
        if (!sameValue(before, after)) return { reason: 'would_change' };
    }
    if (cand.needsEvidence && !evidence) return { reason: 'no_evidence' };
    if (strict && !defined) return { reason: 'no_evidence' };
    return { pick: cand.pick };
}

function dataStates(...states) {
    return states.filter(s => s !== null && typeof s === 'object' && !Array.isArray(s));
}

function resolverFor(evaluate, parse) {
    return createResolver({ evaluate: typeof evaluate === 'function' ? evaluate : noEvaluate, parse });
}

/**
 * The pick a legacy binding is shown as, or null when it is shown as a
 * Formula. A binding that already is a valid pick is returned as it is.
 *
 * @param {unknown} binding — a stored binding ({ kind: 'ref', path } etc.)
 * @param {object | null | undefined} sample — the design-time runState
 * @param {object | null | undefined} [lastRun] — the last real run's runState
 * @param {{ evaluate?: (src: string, scope: object) => unknown, parse?: object }} [deps]
 * @returns {object | null}
 */
export function liftLegacy(binding, sample, lastRun, { evaluate, parse } = {}) {
    if (isPick(binding)) return binding;
    const verdict = checkLift(binding, dataStates(sample, lastRun), resolverFor(evaluate, parse), evaluate, false);
    return verdict.pick || null;
}

// ── M8: "Koppelingen bijwerken", a whole definition at once ─────────────
//
// An opt-in action on one automation (routes/automation/upgradeMappings.js).
// It never runs on load by itself: a stored definition keeps resolving as it
// does until someone who may edit it asks for this, sees the preview and
// applies it, or (M8b) their organisation switched on "update mappings when
// an automation is opened", which applies the same provably-equal rewrite as
// a new version that can be undone.
//
//   upgradeStepRepeat   a legacy forEach + `loop.<var>` refs as a repeat +
//                       `each` picks (repeat.mjs rebaseLoopRefs), checked
//                       item by item against the data
//   upgradeDefinition   that for every step, plus liftLegacy on every ref
//                       of every binding site (sites.mjs), in loop bodies,
//                       parallel branches and flowlets too; an expr stays a
//                       Formula (see upgradeStep)
//
// Each ref is dry-run on every runState at hand (the last real run, the
// pinned samples) and kept as it is when the two resolve differently there,
// a value the legacy binding did not have included. A binding no runState
// gives a value is kept too: without data nothing shows the two agree (a ref
// of plain keys reads differently from its pick where it meets a list or a
// JSON text). The report names steps, fields and the labels of what a value
// reads (label.mjs): never a value from a run.

/** At most this many items of a forEach list are dry-run per runState. */
const MAX_ITEMS_CHECKED = 50;

const REFUSED_LOOP_KEYS = new Set(REFUSED_KEYS);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** As sameValue, but a key whose value is undefined counts as absent (what a step is sent). */
function sameData(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameData(v, b[i]));
    const ka = Object.keys(a).filter(k => a[k] !== undefined);
    const kb = Object.keys(b).filter(k => b[k] !== undefined);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameData(a[k], b[k]));
}

/**
 * Any text left in `value` that still reads the item: a field the sites
 * table does not list (a tool's own option, a code step's source) would lose
 * the item without a word once `loop.<var>` is no longer bound. A literal
 * wrapper is data and is not read.
 */
function stillReadsLoop(value, itemVar) {
    if (typeof value === 'string') return readsLoopItem(value, itemVar);
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(v => stillReadsLoop(v, itemVar));
    if (value.kind === 'literal') return false;
    return Object.keys(value).some(k => stillReadsLoop(value[k], itemVar));
}

/** The fields a step holds bindings in (sites.mjs, kind 'binding'). */
function bindingFields(step) {
    return stepBindingSites(step).filter(site => site.kind === 'binding').map(site => site.field);
}

/** Where a ref of the old step became a pick of the new one: `[{ field, pick }]`. */
function convertedRefs(before, after, field, out) {
    if (isRecord(before) && before.kind === 'ref') {
        if (isPick(after)) out.push({ field, pick: after });
        return out;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        before.forEach((v, i) => convertedRefs(v, after[i], `${field}.${i}`, out));
    } else if (isRecord(before) && isRecord(after) && before.kind !== 'literal') {
        for (const k of Object.keys(before)) convertedRefs(before[k], after[k], `${field}.${k}`, out);
    }
    return out;
}

/**
 * The forEach of `step` as a repeat, checked against `states` with
 * `resolver`. See upgradeStepRepeat.
 */
function repeatUpgrade(step, states, resolver) {
    const fe = step && step.forEach;
    if (isRecord(step) && step.repeat) return { refused: ['already_repeating'] };
    const rebased = rebaseLoopRefs(step);
    if (rebased.refused) return { refused: rebased.refused };
    const out = rebased.step;
    const over = out.repeat.over;
    const itemVar = typeof fe.itemVar === 'string' && fe.itemVar ? fe.itemVar : 'item';

    const fields = bindingFields(step);
    const converted = [];
    for (const field of fields) convertedRefs(fieldValue(step, field), fieldValue(out, field), field, converted);
    // `length` and the prototype keys: the legacy walker reads them, a pick never.
    if (converted.some(c => c.pick.from.path.some(seg => typeof seg === 'string' && REFUSED_LOOP_KEYS.has(seg)))) {
        return { refused: ['loop_ref_unreadable'] };
    }
    const { forEach: _fe, repeat: _repeat, pinnedOutput: _pinned, ...rest } = out;
    if (stillReadsLoop(rest, itemVar)) return { refused: ['loop_elsewhere'] };

    // The cap the forEach ran with (execFlow.js), kept as it was.
    const cap = Math.min(fe.maxIterations || REPEAT_DEFAULT_MAX, REPEAT_MAX);
    if (!Number.isSafeInteger(cap) || cap < 1) return { refused: ['max_unreadable'] };
    out.repeat = { over, max: cap };

    // Item by item: the forEach and the repeat must run for the same items,
    // and every binding must give each of them what it gave before. Each
    // item ref must have read a value at least once, as any binding must
    // (checkLift): a ref the data never filled shows nothing.
    let checked = false;
    const filled = new Set();
    for (const state of states) {
        const legacy = walkPath(fe.overRef, state);
        const read = walkSource(over, state);
        const v2Missing = read === undefined || read === null;
        if (!Array.isArray(legacy)) {
            // The forEach skips this run; a repeat must skip it too, not run
            // once for a single record.
            if (!v2Missing) return { refused: ['list_differs'] };
            continue;
        }
        if (v2Missing) return { refused: ['list_differs'] };
        const items = manyItems(read).items;
        if (!sameValue(legacy, items)) return { refused: ['list_differs'] };
        const n = Math.min(legacy.length, cap, MAX_ITEMS_CHECKED);
        for (let i = 0; i < n; i++) {
            const before = { ...state, loop: { ...(isRecord(state.loop) ? state.loop : {}), [itemVar]: legacy[i], _index: i } };
            const after = { ...state, _mappingScope: { over, item: items[i], index: i } };
            for (const field of fields) {
                const a = resolver.resolveDeep(fieldValue(step, field), before, { silent: true });
                const b = resolver.resolveDeep(fieldValue(out, field), after, { silent: true });
                if (!sameData(a, b)) return { refused: ['would_change'] };
            }
            for (const c of converted) {
                if (walkPath(fieldValue(step, c.field)?.path, before) !== undefined) filled.add(c.field);
            }
            checked = true;
        }
    }
    // A repeat reads its list and its items the v2 way: without one item
    // seen both ways, nothing shows they agree.
    if (!checked || filled.size < converted.length) return { refused: ['no_evidence'] };
    return { step: out, converted };
}

/**
 * A legacy "run once per item" step (forEach + `loop.<var>` refs) as a
 * repeat with `each` picks, only when the data shows it runs the same:
 * the same items, and every binding giving each item what it gave before.
 * The step handed in is not changed.
 *
 * Refused, with the reasons as codes: what rebaseLoopRefs refuses
 * (loop_in_template, loop_in_expr, loop_in_text, loop_index,
 * loop_ref_unreadable, over_unreadable, no_for_each), plus
 * already_repeating, loop_elsewhere (a field outside the sites table reads
 * the item), max_unreadable, list_differs (the forEach and the repeat would
 * not run for the same items), would_change and no_evidence (no runState
 * holds an item of the list).
 *
 * @param {object} step
 * @param {{ sample?: object|null, lastRun?: object|null, evaluate?: Function, parse?: object }} [opts]
 * @returns {{ step: object, converted: Array<{ field: string, pick: object }> } | { refused: string[] }}
 */
export function upgradeStepRepeat(step, { sample, lastRun, evaluate, parse } = {}) {
    if (!isRecord(step)) return { refused: ['no_for_each'] };
    return repeatUpgrade(step, dataStates(sample, lastRun), resolverFor(evaluate, parse));
}

/** A step's name as the person gave it, or null. */
function stepName(step) {
    if (!isRecord(step)) return null;
    for (const key of ['label', 'name', 'title']) {
        if (typeof step[key] === 'string' && step[key].trim()) return step[key].trim();
    }
    return null;
}

/** id → name of every step in a list of steps, nested ones included. */
function collectNames(steps, names) {
    for (const s of Array.isArray(steps) ? steps : []) {
        if (!isRecord(s)) continue;
        if (typeof s.id === 'string') names.set(s.id, stepName(s));
        if (s.type === 'loop') collectNames(s.body, names);
        if (s.type === 'parallel' && Array.isArray(s.branches)) for (const b of s.branches) collectNames(b, names);
    }
    return names;
}

/**
 * How a report entry names what a value reads: the root, the step it comes
 * from (by its name) and the label of the path. `base` is a path prefix the
 * label leaves out (an `each` pick is named inside its item).
 */
function describeRead(from, names, base = []) {
    if (!isRecord(from)) return {};
    const path = Array.isArray(from.path) ? from.path.slice(base.length) : [];
    return {
        root: from.root,
        source: from.root === 'steps' ? (names.get(from.id) ?? null) : null,
        label: labelText(labelParts(path)),
    };
}

function upgradeSteps(steps, ctx) {
    if (!Array.isArray(steps)) return steps;
    return steps.map((step) => {
        if (!isRecord(step) || step.type === 'note') return step;
        let s = upgradeStep(step, ctx);
        if (s.type === 'loop' && Array.isArray(s.body)) s = { ...s, body: upgradeSteps(s.body, ctx) };
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            s = { ...s, branches: s.branches.map(b => (Array.isArray(b) ? upgradeSteps(b, ctx) : b)) };
        }
        return s;
    });
}

function upgradeStep(step, ctx) {
    const where = { stepId: typeof step.id === 'string' ? step.id : null, step: stepName(step), ...(ctx.layer ? { layer: ctx.layer } : {}) };
    let s = step;
    // The item of a forEach that stays: its refs stay with it.
    let keptItemVar = null;
    if (isRecord(step.forEach) && !step.repeat) {
        const over = sourceFromPath(step.forEach.overRef);
        const list = over ? describeRead(over, ctx.names) : {};
        const r = repeatUpgrade(step, ctx.states, ctx.resolver);
        if (r.refused) {
            ctx.kept.push({ ...where, field: 'forEach', kind: 'for_each', reason: r.refused[0], reasons: r.refused, ...list });
            keptItemVar = typeof step.forEach.itemVar === 'string' && step.forEach.itemVar ? step.forEach.itemVar : 'item';
        } else {
            s = r.step;
            ctx.changed.push({ ...where, field: 'forEach', kind: 'for_each', take: 'each', ...list });
            for (const c of r.converted) {
                ctx.changed.push({ ...where, field: c.field, kind: 'ref', take: 'each', ...describeRead(c.pick.from, ctx.names, s.repeat.over.path) });
            }
        }
    }
    const lift = (value, field) => {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map((v, i) => lift(v, `${field}.${i}`));
        if (isPick(value) || isCompose(value)) return value;
        if (value.kind === 'literal' || value.kind === 'template') return value;
        if (value.kind === 'ref' || value.kind === 'expr') {
            const from = value.kind === 'ref' ? sourceFromPath(value.path) : null;
            const text = value.kind === 'ref' ? value.path : value.value;
            if (keptItemVar && readsLoopItem(typeof text === 'string' ? text : '', keptItemVar)) {
                // No runState binds the item, so no dry run reaches it; and a
                // chip of a forEach item is what the repeat is for.
                ctx.kept.push({ ...where, field, kind: value.kind, reason: 'for_each_kept', ...(from ? describeRead(from, ctx.names) : {}) });
                return value;
            }
            // An expr stays a Formula here, whatever the data at hand shows.
            // first/last/join/count differ from their pick on shapes a run
            // seldom holds and a later run easily does: an empty list (null
            // against no value, so the input is dropped instead of sent as
            // null), a null entry, a record ("Key: value" pairs), a text. A
            // dry run on one or two runStates cannot show those agree.
            const verdict = value.kind === 'expr'
                ? { reason: 'formula' }
                : checkLift(value, ctx.states, ctx.resolver, ctx.evaluate, true);
            if (verdict.pick) {
                ctx.changed.push({ ...where, field, kind: value.kind, take: verdict.pick.take, ...describeRead(verdict.pick.from, ctx.names) });
                return verdict.pick;
            }
            ctx.kept.push({ ...where, field, kind: value.kind, reason: verdict.reason, ...(from ? describeRead(from, ctx.names) : {}) });
            return value;
        }
        const out = {};
        for (const k of Object.keys(value)) out[k] = lift(value[k], `${field}.${k}`);
        return out;
    };
    let copied = s === step ? null : s;
    for (const field of bindingFields(s)) {
        const before = fieldValue(s, field);
        const after = lift(before, field);
        if (sameValue(before, after)) continue;
        if (!copied) copied = clone(s);
        setField(copied, field, after);
        s = copied;
    }
    return s;
}

/**
 * Upgrade every mapping of a definition that can be upgraded without
 * changing what a run does: each forEach to a repeat (upgradeStepRepeat)
 * and each ref that lifts to a pick (liftLegacy), dry-run on the runStates
 * given. Exprs, templates, texts and list paths stay as they are: an expr
 * that liftLegacy shows as a chip may still read differently on a list
 * shape the data at hand does not hold (an empty one, above all).
 *
 * Returns the new definition (the one handed in is not changed; when
 * nothing changed it equals the input) and a report: `changed` and `kept`,
 * one entry per binding (and per forEach):
 *
 *   { stepId, step, layer?, field, kind, take?, reason?, reasons?, root?, source?, label? }
 *
 *   step    the step's name, or null; field: where in the step ('inputs.to',
 *           'forEach'); kind: 'ref', 'expr' or 'for_each'
 *   root, source, label   what the value reads: the root, the source step's
 *           name and the label of the path (label.mjs)
 *   reason  why it was kept: 'formula' (an expr, or no pick reads it), 'would_change',
 *           'no_evidence', 'for_each_kept' (a ref of the item of a forEach
 *           that stays), or a code of upgradeStepRepeat
 *
 * A flowlet's steps run in a runState of their own, so the run's data is no
 * evidence there: they get no dry run, and stay as they are ('no_evidence').
 *
 * @param {object} definition
 * @param {{ sample?: object|null, lastRun?: object|null, evaluate?: Function, parse?: object }} [opts]
 * @returns {{ definition: object, changed: object[], kept: object[] }}
 */
export function upgradeDefinition(definition, { sample, lastRun, evaluate, parse } = {}) {
    const changed = [];
    const kept = [];
    if (!isRecord(definition)) return { definition, changed, kept };
    const ctx = {
        states: dataStates(sample, lastRun),
        resolver: resolverFor(evaluate, parse),
        evaluate,
        names: collectNames(definition.steps, new Map()),
        changed,
        kept,
        layer: null,
    };
    const out = { ...definition };
    if (Array.isArray(definition.steps)) out.steps = upgradeSteps(definition.steps, ctx);
    if (isRecord(definition.layers)) {
        const layers = {};
        for (const [key, layer] of Object.entries(definition.layers)) {
            layers[key] = isRecord(layer) && Array.isArray(layer.steps)
                ? { ...layer, steps: upgradeSteps(layer.steps, { ...ctx, states: [], names: collectNames(layer.steps, new Map()), layer: key }) }
                : layer;
        }
        out.layers = layers;
    }
    return { definition: changed.length ? out : definition, changed, kept };
}

// ── M8b: update on open, and the AI fix ─────────────────────────────────
//
// legacyBindings      what the builder looks at when an automation opens: is
//                     there anything left that the action above, or the AI
//                     fix below, could rewrite? Cheap, no data: it reads the
//                     same sites upgradeDefinition rewrites, nothing more.
// replaceableBinding  whether a legacy binding is one the AI fix may replace
//                     at all, before any data is looked at (see legacyReads).
// checkReplacement    the one gate a proposed replacement of a legacy binding
//                     passes before anyone may apply it (the AI fix,
//                     server/automation/mappingAiFix.js). Who proposed it does
//                     not matter; it must read exactly the values the legacy
//                     binding reads, resolve to exactly what that resolves to
//                     on every runState at hand (one of which gives a value),
//                     and keep doing so when each value it reads is replaced by
//                     the shapes a later run easily holds (EDGE_VALUES).

/** Every legacy ref or expr in `value` (a pick, a compose, a literal and a template are not). */
function collectLegacy(value, field, where, out) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((v, i) => collectLegacy(v, `${field}.${i}`, where, out)); return; }
    if (isPick(value) || isCompose(value)) return;
    if (value.kind === 'literal' || value.kind === 'template') return;
    if (value.kind === 'ref') { out.push({ ...where, field, kind: 'ref', text: typeof value.path === 'string' ? value.path : '' }); return; }
    if (value.kind === 'expr') { out.push({ ...where, field, kind: 'expr', text: typeof value.value === 'string' ? value.value : '' }); return; }
    for (const k of Object.keys(value)) collectLegacy(value[k], `${field}.${k}`, where, out);
}

function collectSteps(steps, out) {
    for (const step of Array.isArray(steps) ? steps : []) {
        if (!isRecord(step) || step.type === 'note') continue;
        const where = { stepId: typeof step.id === 'string' ? step.id : null };
        if (isRecord(step.forEach) && !step.repeat) {
            out.push({ ...where, field: 'forEach', kind: 'for_each', text: typeof step.forEach.overRef === 'string' ? step.forEach.overRef : '' });
        }
        for (const field of bindingFields(step)) collectLegacy(fieldValue(step, field), field, where, out);
        if (step.type === 'loop') collectSteps(step.body, out);
        if (step.type === 'parallel' && Array.isArray(step.branches)) for (const b of step.branches) collectSteps(b, out);
    }
    return out;
}

/**
 * The legacy bindings of a definition's own graph that an upgrade could
 * rewrite: `[{ stepId, field, kind: 'ref'|'expr'|'for_each', text }]`, in
 * step order. The same sites upgradeDefinition walks (a forEach, and every
 * ref and expr in a binding site); a flowlet's steps are left out, since no
 * run's data reaches them (see upgradeDefinition). `text` is the path or the
 * expression as stored: the definition's own text, never a run value.
 * @param {unknown} definition
 * @returns {Array<{ stepId: string|null, field: string, kind: 'ref'|'expr'|'for_each', text: string }>}
 */
export function legacyBindings(definition) {
    return isRecord(definition) ? collectSteps(definition.steps, []) : [];
}

/** Whether a definition still holds a legacy binding an upgrade could rewrite (legacyBindings). */
export function hasLegacyBindings(definition) {
    return legacyBindings(definition).length > 0;
}

// What a legacy binding reads, and whether that is something a dry run on
// the run's data can speak for at all.

/** The roots a run-level runState binds (sourceBase): a dry run here sees their values. */
const RUN_ROOTS = new Set(['steps', 'trigger', 'run', 'vars']);

/** The expr identifiers that are values, not reads. */
const EXPR_WORDS = new Set(['true', 'false', 'null']);

// One segment of a member chain in an expr: `.key`, `[0]`, `[*]`, `["key"]`.
const CHAIN_SEGMENT = /\s*(?:\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|\[\s*([0-9]+|\*|"[^"]*"|'[^']*')\s*\])/y;
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** The key a Source is compared by: root, step and path. */
function sourceKey(from) {
    return JSON.stringify([from.root, from.root === 'steps' ? from.id : null, from.path]);
}

/**
 * The Sources an expr reads, or null when it reads anything a dry run on the
 * run's data cannot speak for. Each root an expr names (an identifier that
 * is not a member, a function or a word) must start a plain member chain
 * (`steps.s1.output.items[*].name`) that sourceFromPath reads; a computed
 * index, a member call or any other root (`loop`, `item`, a row's own keys)
 * is null. first/last/count/join anywhere are null too: they differ from
 * their pick on an empty list, a null entry, a record and a text (see
 * upgradeStep), which is what M8 refuses to rewrite.
 */
function exprReads(text) {
    // Same length, so an index in `blank` is one in `text`.
    const blank = text.replace(STRING_LITERAL, m => `${m[0]}${' '.repeat(m.length - 2)}${m[0]}`);
    const reads = [];
    for (const m of blank.matchAll(IDENTIFIER)) {
        const name = m[0];
        const end = m.index + name.length;
        if (/\.\s*$/.test(blank.slice(0, m.index))) continue; // a member: read with its chain
        if (/[0-9]$/.test(blank.slice(0, m.index))) return null; // `1e5`-like: not a name we read
        if (/^\s*\(/.test(blank.slice(end))) {
            if (Object.prototype.hasOwnProperty.call(FUNCTION_TAKES, name)) return null;
            continue;
        }
        if (EXPR_WORDS.has(name)) continue;
        if (name !== 'steps' && name !== 'trigger' && name !== 'vars') return null;
        let path = name;
        let at = end;
        for (;;) {
            CHAIN_SEGMENT.lastIndex = at;
            const seg = CHAIN_SEGMENT.exec(text);
            if (!seg) break;
            path += seg[1] !== undefined ? `.${seg[1]}` : `[${seg[2]}]`;
            at = CHAIN_SEGMENT.lastIndex;
        }
        // A chain that goes on as something we do not read: a computed index, a call.
        if (/^\s*[[(]/.test(blank.slice(at))) return null;
        const from = sourceFromPath(path);
        if (!from || !RUN_ROOTS.has(from.root)) return null;
        reads.push(from);
    }
    return reads;
}

/**
 * The Sources a legacy ref or expr reads (`[{ root, id?, path }]`), or null
 * when it is no binding the AI fix may replace: not a ref or an expr, or one
 * that reads a scope no run-level runState binds (the item of a loop or a
 * forEach, the row of a list step), or a formula that calls first, last,
 * count or join (exprReads). Bindings only the runtime scope fills would
 * look like constants to a dry run, and the list functions differ from any
 * pick on shapes a dry run seldom holds.
 */
function legacyReads(binding) {
    if (!isRecord(binding)) return null;
    if (binding.kind === 'ref') {
        const from = typeof binding.path === 'string' ? sourceFromPath(binding.path) : null;
        return from && RUN_ROOTS.has(from.root) ? [from] : null;
    }
    if (binding.kind === 'expr') return typeof binding.value === 'string' ? exprReads(binding.value) : null;
    return null;
}

/**
 * Whether the AI fix may replace this legacy binding at all, before any
 * data is looked at: a ref or an expr that reads at least one value, and
 * only values a run-level runState holds (see legacyReads).
 * @param {unknown} binding
 * @returns {boolean}
 */
export function replaceableBinding(binding) {
    const reads = legacyReads(binding);
    return !!reads && reads.length > 0;
}

// The shapes a value a run reads may turn out to have on a later run, even
// when no runState at hand holds them: gone, empty, a null entry, a list, a
// text, a record, a number. A replacement must give what the legacy binding
// gives on each (first() of [] is null where a pick gives no value, a `+`
// writes null as "null" where a compose writes nothing, ...).
const ABSENT = Symbol('absent');
const UNREACHABLE = Symbol('unreachable');
const EDGE_VALUES = Object.freeze([ABSENT, null, [], [null], ['a', 'b'], 'text', { key: 'value' }, 0]);

/**
 * `value` with whatever `path` reaches (from segment `i`) replaced by
 * `leaf`, copied along the way and never changed in place; a key on a list
 * is replaced in every element, as a pick reads it. UNREACHABLE where the
 * path runs into a text or a number: what a walk reads there (a JSON text)
 * is not something to replace.
 */
function withLeaf(value, path, i, leaf) {
    if (i === path.length) return leaf;
    const seg = path[i];
    let cur = value;
    if (cur === undefined || cur === null) cur = typeof seg === 'number' ? [] : {};
    if (typeof cur !== 'object') return UNREACHABLE;
    if (Array.isArray(cur) && typeof seg !== 'number') {
        const out = (cur.length ? cur : [{}]).map(el => withLeaf(el, path, i, leaf));
        return out.includes(UNREACHABLE) ? UNREACHABLE : out;
    }
    const key = String(seg);
    if (REFUSED_KEYS.includes(key)) return UNREACHABLE;
    const next = withLeaf(Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : undefined, path, i + 1, leaf);
    if (next === UNREACHABLE) return UNREACHABLE;
    const copy = Array.isArray(cur) ? [...cur] : { ...cur };
    if (next !== ABSENT) copy[key] = next;
    else if (Array.isArray(copy)) copy[key] = undefined;
    else delete copy[key];
    return copy;
}

/** A runState with the value `from` reads replaced by `leaf` (withLeaf), or UNREACHABLE. */
function withSourceValue(state, from, leaf) {
    const own = (o, k) => (isRecord(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
    const fill = (v) => (v === ABSENT ? undefined : v);
    if (from.root === 'steps') {
        const steps = isRecord(state.steps) ? state.steps : {};
        const entry = isRecord(steps[from.id]) ? steps[from.id] : {};
        const output = withLeaf(entry.output, from.path, 0, leaf);
        return output === UNREACHABLE ? UNREACHABLE : { ...state, steps: { ...steps, [from.id]: { ...entry, output: fill(output) } } };
    }
    if (from.root === 'trigger') {
        const trigger = isRecord(state.trigger) ? state.trigger : {};
        const output = withLeaf(trigger.output, from.path, 0, leaf);
        return output === UNREACHABLE ? UNREACHABLE : { ...state, trigger: { ...trigger, output: fill(output) } };
    }
    if (from.root === 'run' || from.root === 'vars') {
        const key = from.root === 'run' ? 'trigger' : 'vars';
        // A run Source names a key of the trigger itself: never replace it whole.
        if (from.root === 'run' && !from.path.length) return UNREACHABLE;
        const base = withLeaf(own(state, key), from.path, 0, leaf);
        return base === UNREACHABLE ? UNREACHABLE : { ...state, [key]: fill(base) };
    }
    return UNREACHABLE;
}

/**
 * Whether `proposal` may replace the legacy `binding`: `{ ok: true }`, or
 * `{ ok: false, reason }` with
 *   'invalid'       not a binding the fix may replace (replaceableBinding:
 *                   a loop item, a row, a list function, ...), or the
 *                   proposal is no valid pick or compose (validate.mjs),
 *                   reads the item of a repeat or a loop, reads nothing, or
 *                   does not read exactly the values the legacy binding
 *                   reads (a later step, the field's own step, another key
 *                   that happens to hold the same value today)
 *   'would_change'  a runState where the two resolve differently, an
 *                   undefined on one side included, or an EDGE_VALUES shape
 *                   of a value they read on which they do
 *   'no_evidence'   no runState gives the legacy binding a value (null and
 *                   an empty list are none either), or a value it reads
 *                   could not be tried in another shape: without data
 *                   nothing shows they agree, so nothing may change
 *
 * @param {unknown} binding — the stored legacy binding
 * @param {unknown} proposal — the pick or compose proposed for it
 * @param {{ sample?: object|null, lastRun?: object|null, evaluate?: Function, parse?: object }} [opts]
 * @returns {{ ok: true } | { ok: false, reason: 'invalid'|'would_change'|'no_evidence' }}
 */
export function checkReplacement(binding, proposal, { sample, lastRun, evaluate, parse } = {}) {
    const reads = legacyReads(binding);
    if (!reads || !reads.length) return { ok: false, reason: 'invalid' };
    if (!isPick(proposal) && !isCompose(proposal)) return { ok: false, reason: 'invalid' };
    const picks = isPick(proposal) ? [proposal] : proposal.parts.filter(p => typeof p !== 'string');
    if (!picks.length || picks.some(p => p.take === 'each' || !RUN_ROOTS.has(p.from.root))) return { ok: false, reason: 'invalid' };
    // The same values, no more and no fewer: a dry run holds every step's
    // final output, a later step's too, so a proposal reading another
    // Source that holds the same value today would pass it, and at run time
    // read nothing (or something else).
    const legacyKeys = new Set(reads.map(sourceKey));
    const sources = new Map(picks.map(p => [sourceKey(p.from), p.from]));
    if (legacyKeys.size !== sources.size || [...legacyKeys].some(k => !sources.has(k))) return { ok: false, reason: 'invalid' };

    const resolver = resolverFor(evaluate, parse);
    const states = dataStates(sample, lastRun);
    const differs = (state) => !sameValue(
        resolver.resolveValue(binding, state, { silent: true }),
        resolver.resolveValue(proposal, state, { silent: true }),
    );
    let evidence = false;
    for (const state of states) {
        if (differs(state)) return { ok: false, reason: 'would_change' };
        if (!isEmptyData(resolver.resolveValue(binding, state, { silent: true }))) evidence = true;
    }
    if (!evidence) return { ok: false, reason: 'no_evidence' };
    // Every value read, in every shape a later run may hand it, at least once.
    for (const from of sources.values()) {
        let tried = false;
        for (const state of states) {
            for (const leaf of EDGE_VALUES) {
                const variant = withSourceValue(state, from, leaf);
                if (variant === UNREACHABLE) continue;
                if (differs(variant)) return { ok: false, reason: 'would_change' };
                tried = true;
            }
        }
        if (!tried) return { ok: false, reason: 'no_evidence' };
    }
    return { ok: true };
}
