/**
 * Follow the route — a step hanging off a Condition that works through a
 * list reads what that Condition KEEPS, not the list it was given.
 *
 * Without this, inserting a Condition between "Read many" and "Read
 * attachment" changed nothing: Read attachment kept reading Read many's
 * messages, so the canvas said "kept 3 of 4" while all 11 attachments were
 * read. Every path that changes the wiring (insert on a connection, add
 * after, one ↔ several outputs, renaming an output, a deeper list, the AI
 * builder, the phone) calls one of the functions below, so the web, the
 * phone and the server re-point steps identically.
 *
 * A LIST ROUTE is a `filter`, or a `switch` with an `arrayRef`. Its outputs:
 * a filter's kept rows at `steps.<id>.output.items`; a list switch's rows
 * per output at `steps.<id>.output.matchesByCase.<name>` (`default` for
 * Otherwise). Paths compare as token lists, so `steps["s3"].output` and
 * `steps.s3.output` are the same path. Only `definition.steps` (top level)
 * and `definition.edges` are read; `on_error` edges are not a route.
 *
 * Pure: every function returns new objects and never mutates its input.
 */

import { appendKey, formatPath, parsePath, readPath, replaceTemplate } from './path.mjs';

// ── Paths ────────────────────────────────────────────────────────────────

const ROOTS = new Set(['steps', 'trigger', 'loop']);
// Keys that hold no binding: rewriting them would change names, layout or samples.
const SKIP_KEYS = new Set(['id', 'label', 'position', 'pinnedOutput', 'pinnedAt', 'pinnedSource', 'notes', 'description']);

function sameToken(a, b) {
    if (a.type !== b.type) return false;
    if (a.type === 'wild') return true;
    if (a.type === 'match') return a.key === b.key && a.value === b.value;
    return String(a.key) === String(b.key);
}

const startsWithTokens = (tokens, prefix) => prefix.length <= tokens.length && prefix.every((t, i) => sameToken(t, tokens[i]));
const isProperPrefix = (short, long) => short.length < long.length && startsWithTokens(long, short);

/** Is `step` a Condition that works through a list (filter, or switch with an arrayRef)? */
export function isListRoute(step) {
    if (!step || typeof step !== 'object') return false;
    if (step.type !== 'filter' && step.type !== 'switch') return false;
    return typeof step.arrayRef === 'string' && step.arrayRef.trim() !== '';
}

const outputPath = (id, ...keys) => keys.reduce((p, k) => appendKey(p, k), appendKey(appendKey('steps', id), 'output'));

/** The output name an edge leaves a switch by (`case:pdf` → pdf, Otherwise → default); null when none. */
function caseOfEdge(edge) {
    if (!edge) return null;
    if (edge.caseName != null) return String(edge.caseName);
    return typeof edge.label === 'string' && edge.label.startsWith('case:') ? edge.label.slice(5) : null;
}

/** The list a step hanging off `edge` of route `step` should read; null when the edge carries none. */
export function routeListPath(step, edge) {
    if (!isListRoute(step) || (edge && edge.label === 'on_error')) return null;
    if (step.type === 'filter') return outputPath(step.id, 'items');
    const name = caseOfEdge(edge);
    return name ? outputPath(step.id, 'matchesByCase', name) : null;
}

const caseNames = (step) => (Array.isArray(step.cases) ? step.cases : [])
    .filter((c) => c && typeof c.name === 'string' && c.name !== '')
    .map((c) => c.name);

/** Every list a route publishes: a filter's `items`; a list switch's outputs in order, then Otherwise. */
export function routeOutputPaths(step) {
    if (!isListRoute(step)) return [];
    if (step.type === 'filter') return [outputPath(step.id, 'items')];
    return [...caseNames(step), 'default'].map((name) => outputPath(step.id, 'matchesByCase', name));
}

// ── Switch cases ─────────────────────────────────────────────────────────

const namesOfCases = (cases) => (Array.isArray(cases) ? cases : [])
    .map((c) => (c && typeof c.name === 'string' ? c.name : ''))
    .filter((name) => name !== '');

/**
 * What a change to a switch's cases does to its outputs, by NAME. A rename
 * is a case whose name changed in place: the list kept its length, the old
 * name left it and the new name was not in it. Everything else keeps its
 * name: a reorder (first match wins, so it changes priority) moves no
 * output, an added case is a new output, and a removed case's output is
 * gone. The edges (relabelSwitchEdges) and the steps reading the outputs
 * (followRouteEdit) follow this one diff, on the web, the phone and the
 * server alike, so a step never hangs off one output while reading another.
 * Returns `{ renames: Map<old, new>, removed: Set<name> }`.
 */
export function switchCaseChanges(prevCases, nextCases) {
    const prev = namesOfCases(prevCases);
    const next = namesOfCases(nextCases);
    const prevNames = new Set(prev);
    const nextNames = new Set(next);
    const renames = new Map();
    if (prev.length === next.length) {
        prev.forEach((name, i) => {
            const to = next[i];
            if (to !== name && !nextNames.has(name) && !prevNames.has(to)) renames.set(name, to);
        });
    }
    const removed = new Set(prev.filter((name) => !nextNames.has(name) && !renames.has(name)));
    return { renames, removed };
}

const edgeIdentityKey = (e) => `${e.from}->${e.to}|${e.label || ''}|${e.caseName ?? ''}`;

/**
 * Re-point switch `stepId`'s edges and its `defaultBranch` after its cases
 * went from `prevCases` to `nextCases` (switchCaseChanges): a renamed case's
 * edges take the new name (label and caseName, healing the legacy one-field
 * shapes), a removed case's edges go, `case:default` is never touched, and
 * an edge that became a duplicate is dropped. The same definition when
 * nothing had to change.
 */
export function relabelSwitchEdges(definition, stepId, prevCases, nextCases) {
    if (!definition || !stepId) return definition;
    const { renames, removed } = switchCaseChanges(prevCases, nextCases);
    if (renames.size === 0 && removed.size === 0) return definition;
    const seen = new Set();
    const edges = [];
    for (const e of Array.isArray(definition.edges) ? definition.edges : []) {
        let out = e;
        const name = e && e.from === stepId ? caseOfEdge(e) : null;
        if (name != null && name !== 'default') {
            if (removed.has(name)) continue;
            const renamed = renames.get(name);
            if (renamed) out = { ...e, label: `case:${renamed}`, caseName: renamed };
        }
        const key = out ? edgeIdentityKey(out) : null;
        if (key !== null && seen.has(key)) continue;
        if (key !== null) seen.add(key);
        edges.push(out);
    }
    const healStep = (s) => {
        if (!s || s.id !== stepId || typeof s.defaultBranch !== 'string' || !s.defaultBranch) return s;
        if (renames.has(s.defaultBranch)) return { ...s, defaultBranch: renames.get(s.defaultBranch) };
        if (removed.has(s.defaultBranch)) return { ...s, defaultBranch: null };
        return s;
    };
    const steps = Array.isArray(definition.steps) ? definition.steps : [];
    return { ...definition, edges, steps: steps.map(healStep) };
}

/**
 * The outputs that carry over from `previous` to `step`: `{ from, to }` per
 * output of `step`, `from` null for a new one. Two switches pair by NAME
 * (switchCaseChanges), as their edges do; any other change (one output ↔
 * several, a type change) pairs by SLOT, as reconcileRouteEdges re-points
 * the edges.
 */
function carriedOutputs(previous, step) {
    if (previous.type === 'switch' && step.type === 'switch') {
        const { renames } = switchCaseChanges(previous.cases, step.cases);
        const oldNameOf = new Map([...renames].map(([from, to]) => [to, from]));
        const had = new Set([...caseNames(previous), 'default']);
        return [...caseNames(step), 'default'].map((name) => {
            const was = oldNameOf.get(name) ?? (had.has(name) ? name : null);
            return {
                from: was === null ? null : outputPath(previous.id, 'matchesByCase', was),
                to: outputPath(step.id, 'matchesByCase', name),
            };
        });
    }
    const before = slotPaths(previous);
    return [...slotPaths(step)].map(([slot, to]) => ({ from: before.get(slot) || null, to }));
}

/** The output list per SLOT (0..n-1 in case order, 'otherwise' for the catch-all): what edges keep across a change. */
function slotPaths(step) {
    const out = new Map();
    if (!isListRoute(step)) return out;
    if (step.type === 'filter') {
        out.set('0', outputPath(step.id, 'items'));
        return out;
    }
    caseNames(step).forEach((name, i) => out.set(String(i), outputPath(step.id, 'matchesByCase', name)));
    out.set('otherwise', outputPath(step.id, 'matchesByCase', 'default'));
    return out;
}

// ── Walking the references in a step ─────────────────────────────────────

/**
 * Every path in an expression that starts at steps / trigger / loop, outside
 * quotes, through `fn(tokens) → tokens | null` (null = keep it as it is).
 */
function mapExpr(text, fn) {
    let out = '';
    let last = 0;
    let quote = null;
    for (let i = 0; i < text.length;) {
        const c = text[i];
        if (quote) {
            i += c === '\\' ? 2 : 1;
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; i++; continue; }
        const r = readPath(text, i);
        if (!r) { i++; continue; }
        const next = ROOTS.has(r.tokens[0].key) ? fn(r.tokens) : null;
        if (next) {
            out += text.slice(last, i) + formatPath(next);
            last = r.end;
        }
        i = Math.max(r.end, i + 1);
    }
    return last === 0 ? text : out + text.slice(last);
}

/** A whole path, else an expression. */
function mapCode(text, fn) {
    const tokens = parsePath(text);
    if (tokens) {
        const next = fn(tokens);
        return next ? formatPath(next) : text;
    }
    return mapExpr(text, fn);
}

/** A template (`{{ … }}` placeholders), a whole path, or an expression. */
function mapString(text, fn) {
    if (!text.includes('{{')) return mapCode(text, fn);
    return replaceTemplate(text, (inner, raw) => {
        const next = mapCode(inner, fn);
        if (next === inner) return raw;
        const at = raw.indexOf(inner);
        return raw.slice(0, at) + next + raw.slice(at + inner.length);
    });
}

/** Rewrite every reference inside a value; the same object when nothing changed. */
function mapValue(value, fn) {
    if (typeof value === 'string') return mapString(value, fn);
    if (Array.isArray(value)) {
        const next = value.map((v) => mapValue(v, fn));
        return next.some((v, i) => v !== value[i]) ? next : value;
    }
    if (!value || typeof value !== 'object' || value.kind === 'literal') return value;
    let out = null;
    for (const [k, v] of Object.entries(value)) {
        if (SKIP_KEYS.has(k)) continue;
        const next = mapValue(v, fn);
        if (next === v) continue;
        if (!out) out = { ...value };
        out[k] = next;
    }
    return out || value;
}

/**
 * Rewrite with several `{ from, to }` pairs at once: each reference is
 * rewritten by the longest `from` it starts with, once (so renaming a → b
 * and b → a in one go swaps them). `hits` collects the pairs that applied.
 */
function rebaseWith(value, pairs, hits = new Set()) {
    const parsed = pairs
        .map((p, index) => ({ ...p, index, fromTokens: parsePath(p.from), toTokens: parsePath(p.to) }))
        .filter((p) => p.fromTokens && p.toTokens)
        .sort((a, b) => b.fromTokens.length - a.fromTokens.length);
    if (!parsed.length) return value;
    return mapValue(value, (tokens) => {
        const p = parsed.find((x) => startsWithTokens(tokens, x.fromTokens));
        if (!p) return null;
        hits.add(p.index);
        return [...p.toTokens, ...tokens.slice(p.fromTokens.length)];
    });
}

/**
 * Rewrite every reference that starts with `from` to start with `to`
 * instead: refs, templates, expressions (rule texts included), forEach and
 * list fields. Literal bindings, names, notes and pinned samples are left.
 */
export function rebaseRefs(value, from, to) {
    const next = rebaseWith(value, [{ from, to }]);
    return { value: next, changed: next !== value };
}

/** Does anything in `step` read `path` (or something under it)? */
export function stepReadsPath(step, path) {
    const want = parsePath(path);
    if (!want) return false;
    let found = false;
    mapValue(step, (tokens) => {
        if (startsWithTokens(tokens, want)) found = true;
        return null;
    });
    return found;
}

/** Drop the `forEach.parents` that are no longer an outer part of the step's own list. */
function pruneParents(step) {
    const fe = step && step.forEach;
    if (!fe || !Array.isArray(fe.parents)) return step;
    const own = parsePath(fe.overRef);
    const kept = fe.parents.filter((p) => {
        const pt = p && typeof p.overRef === 'string' ? parsePath(p.overRef) : null;
        return !own || !pt || isProperPrefix(pt, own);
    });
    if (kept.length === fe.parents.length) return step;
    const forEach = { ...fe, parents: kept };
    if (!kept.length) delete forEach.parents;
    return { ...step, forEach };
}

// ── Following ────────────────────────────────────────────────────────────

const stepsOf = (definition) => (definition && Array.isArray(definition.steps) ? definition.steps : []);
const stepById = (definition, id) => stepsOf(definition).find((s) => s && s.id === id) || null;
const routeEdges = (definition) => (definition && Array.isArray(definition.edges) ? definition.edges : [])
    .filter((e) => e && e.label !== 'on_error');

/**
 * Apply `pairs` to each step in `ids` (a Set; null = every step but `skip`).
 * Returns the new definition (the same object when nothing changed) and one
 * `{ stepId, from, to }` per pair that rewrote something in a step.
 */
function rebaseSteps(definition, plan) {
    const rebound = [];
    let changed = false;
    const steps = stepsOf(definition).map((step) => {
        const pairs = step ? plan(step) : null;
        if (!pairs || !pairs.length) return step;
        const hits = new Set();
        const next = rebaseWith(step, pairs, hits);
        if (next === step) return step;
        changed = true;
        for (const i of [...hits].sort((a, b) => a - b)) rebound.push({ stepId: step.id, from: pairs[i].from, to: pairs[i].to });
        return pruneParents(next);
    });
    return { definition: changed ? { ...definition, steps } : definition, rebound };
}

/** For each step hanging off `route`: from its source list and its other outputs to the output it hangs off. */
function successorPairs(definition, route, onlyIds = null) {
    const byTarget = new Map();
    for (const e of routeEdges(definition)) {
        if (e.from !== route.id || byTarget.has(e.to) || (onlyIds && !onlyIds.has(e.to))) continue;
        const to = routeListPath(route, e);
        if (!to) continue;
        const froms = [route.arrayRef, ...routeOutputPaths(route).filter((p) => p !== to)];
        byTarget.set(e.to, froms.map((from) => ({ from, to })));
    }
    return byTarget;
}

/** Merge per-step pair lists (`Map<stepId, pairs>`). */
function mergePlans(...maps) {
    const out = new Map();
    for (const m of maps) for (const [id, pairs] of m) out.set(id, [...(out.get(id) || []), ...pairs]);
    return out;
}

/**
 * After step `stepId` was added, inserted or moved: (a) when it is a list
 * route, each step hanging off it reads the output it hangs off; (b) when it
 * hangs off a list route, it reads that route's output. `rebound` names
 * every rewrite: `{ stepId, from, to }`.
 */
export function followRouteAround(definition, stepId) {
    const step = stepById(definition, stepId);
    if (!step) return { definition, rebound: [] };
    const plans = [];
    if (isListRoute(step)) plans.push(successorPairs(definition, step));
    for (const e of routeEdges(definition)) {
        if (e.to !== stepId) continue;
        const route = stepById(definition, e.from);
        if (isListRoute(route)) plans.push(successorPairs(definition, route, new Set([stepId])));
    }
    const plan = mergePlans(...plans);
    return rebaseSteps(definition, (s) => plan.get(s.id));
}

/** (a) of followRouteAround for chosen successors of a route: the "Use what this Condition keeps" button. */
export function followSuccessors(definition, routeId, stepIds) {
    const route = stepById(definition, routeId);
    if (!isListRoute(route)) return { definition, rebound: [] };
    const plan = successorPairs(definition, route, new Set(stepIds || []));
    return rebaseSteps(definition, (s) => plan.get(s.id));
}

/** `{ deeper: key }` when `next` reads one list level inside `prev` (L → L[*].k); null otherwise. */
function deepenedBy(prev, next) {
    if (!isListRoute(prev) || !isListRoute(next)) return null;
    const a = parsePath(prev.arrayRef);
    const b = parsePath(next.arrayRef);
    if (!a || !b || b.length !== a.length + 2 || !startsWithTokens(b, a)) return null;
    const [wild, key] = b.slice(a.length);
    return wild.type === 'wild' && key.type === 'prop' ? key.key : null;
}

/**
 * After the route step itself changed (`definition` holds the new step,
 * `previousStep` the old one). Outputs pair as the edges do (carriedOutputs):
 * one output → several moves `items` to the first output, several → one
 * moves the first back to `items`, and between two switches an output keeps
 * its readers by name: a rename carries them along, a reorder or an added
 * case moves nobody, and a removed case's readers are left alone (never
 * shifted onto a neighbour). A list one level deeper (L → L[*].k) also turns
 * `<output>[*].k` into `<output>` and drops forEach parents that no longer
 * fit. Every step but the route is rewritten. A whole-run Condition (or a
 * switch without a list) that becomes a list route ("Check each item
 * instead") has no old outputs: its direct successors are followed as after
 * an insert. The reverse ("The whole run" again) publishes no list any more,
 * so every step reading one of its outputs goes back to the list it was given.
 */
export function followRouteEdit(definition, routeId, previousStep) {
    const step = stepById(definition, routeId);
    if (!step || !previousStep) return { definition, rebound: [] };
    if (!isListRoute(previousStep) && isListRoute(step)) {
        const plan = successorPairs(definition, step);
        return rebaseSteps(definition, (s) => plan.get(s.id));
    }
    const previous = { ...previousStep, id: routeId };
    if (isListRoute(previousStep) && !isListRoute(step)) {
        const back = routeOutputPaths(previous).map((from) => ({ from, to: previousStep.arrayRef }));
        return rebaseSteps(definition, (s) => (s.id === routeId ? null : back));
    }
    const carried = carriedOutputs(previous, step);
    const pairs = carried.filter((c) => c.from && c.from !== c.to);
    const deeper = deepenedBy(previousStep, step);
    if (deeper !== null) {
        // Both spellings collapse: the old output's `[*].k` (a type change in
        // the same edit, e.g. filter → switch, renamed the output too) and the
        // new one's.
        for (const { from, to } of carried) {
            if (from && from !== to) pairs.push({ from: appendKey(`${from}[*]`, deeper), to });
            pairs.push({ from: appendKey(`${to}[*]`, deeper), to });
        }
    }
    if (!pairs.length) return { definition, rebound: [] };
    return rebaseSteps(definition, (s) => (s.id === routeId ? null : pairs));
}

/**
 * The steps hanging directly off a list route that still read its source
 * list and none of its outputs: what the route drops still reaches them.
 * `reads` is the source list, `to` the output each should read.
 */
export function staleSuccessors(definition, routeId) {
    const route = stepById(definition, routeId);
    if (!isListRoute(route)) return [];
    const outputs = routeOutputPaths(route);
    const out = [];
    const seen = new Set();
    for (const e of routeEdges(definition)) {
        if (e.from !== routeId || seen.has(e.to)) continue;
        seen.add(e.to);
        const target = stepById(definition, e.to);
        const to = routeListPath(route, e);
        if (!target || !to || !stepReadsPath(target, route.arrayRef)) continue;
        if (outputs.some((p) => stepReadsPath(target, p))) continue;
        out.push({ stepId: target.id, reads: route.arrayRef, to });
    }
    return out;
}

