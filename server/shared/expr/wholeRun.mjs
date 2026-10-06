/**
 * A Condition that decides for the WHOLE run, reading a list.
 *
 * `contains(steps.sheets.output.results[*].name, "Reiskosten")` on a
 * whole-run Condition asks one question about the list as a whole: the run
 * goes one way for all its items, and every sheet is processed anyway. The
 * author almost always meant "keep the sheets whose name contains
 * Reiskosten", which is the same node working through the list (a Filter).
 * These helpers find that situation so the editor, the phone and the
 * validator can say so:
 *
 * - `wholeRunListReads(step, isList?)` names the lists a whole-run
 *   condition/switch reads as a whole (`isList(path)` answers true/false, or
 *   returns the list itself, e.g. `getList(sampleRoot, path)`, or null);
 * - `loopsAfterWholeRun(definition, condId, isList?)` names the steps right
 *   after it that still run once per item of such a list.
 *
 * Whole-list emptiness checks are legitimate and skipped: a path used only as
 * the whole argument of `isEmpty(…)`, `len(…)` / `count(…)`, or as a bare
 * truthy test (`steps.x.output.items && …`, `!steps.x.output.items`). So is
 * a list of plain values read whole, without `[*]`
 * (`contains(trigger.output.labels, "urgent")`): that is a membership question
 * about the run, not a filter the author forgot. Telling it apart needs the
 * list, so it is skipped when `isList` returns one.
 *
 * Pure; reads `definition.steps` (top level) and `definition.edges` only, and
 * ignores `on_error` edges.
 */

import { parseExpr } from './engine.mjs';
import { formatPath, parsePath } from './path.mjs';
import { stepReadsPath } from './routeFollow.mjs';
import { TOPIC_HOST_SPEC } from './topics.mjs';

const EMPTINESS_FNS = new Set(['isEmpty', 'len', 'count']);
const TRUTHY_PARENTS = new Set(['&&', '||']);

/** AST path segments → path tokens; null when a segment is computed. */
function segmentsToTokens(segments) {
    const tokens = [];
    for (const s of segments) {
        if (s.kind === 'name') tokens.push({ type: 'prop', key: s.v });
        else if (s.kind === 'wildcard') tokens.push({ type: 'wild' });
        else if (s.kind === 'match') tokens.push({ type: 'match', key: s.key, value: s.value });
        else if (s.kind === 'index' && s.expr && (s.expr.kind === 'str' || s.expr.kind === 'num')) tokens.push({ type: 'prop', key: String(s.expr.v) });
        else return null;
    }
    return tokens;
}

/** Is a path node in this position only a whole-list emptiness / truthiness check? */
function isEmptinessUse(parent, key) {
    if (!parent) return true; // the whole expression is the path: a truthy test
    if (parent.kind === 'unop' && parent.op === '!') return true;
    if (parent.kind === 'binop' && TRUTHY_PARENTS.has(parent.op)) return true;
    if (parent.kind === 'ternary' && key === 'cond') return true;
    return parent.kind === 'call' && EMPTINESS_FNS.has(parent.name) && parent.args.length === 1;
}

/** Visit every path node with its parent node and the key it sits under. */
function walkPaths(node, visit, parent = null, key = null) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'path') {
        visit(node, parent, key);
        return;
    }
    for (const k of ['cond', 'a', 'b']) if (node[k]) walkPaths(node[k], visit, node, k);
    if (Array.isArray(node.args)) for (const arg of node.args) walkPaths(arg, visit, node, 'args');
}

/** The part of a path before its first `[*]`; null when it has none. */
function listBeforeWildcard(tokens) {
    const at = tokens.findIndex((t) => t.type === 'wild');
    return at > 0 ? formatPath(tokens.slice(0, at)) : null;
}

/** A non-empty list of plain values (no records), the run reads as a membership set. */
function isPlainValueList(value) {
    return Array.isArray(value) && value.length > 0 && value.every((v) => v === null || typeof v !== 'object');
}

/**
 * Does `isList` say the path holds a list worth a notice? It may answer a
 * boolean, or return the list (an array; `[]` still counts) or null. A list
 * of plain values read whole is a membership test, not a list read.
 */
function readsWholeList(isList, path) {
    if (typeof isList !== 'function') return false;
    const v = isList(path);
    if (Array.isArray(v)) return !isPlainValueList(v);
    return !!v;
}

function readsOfExpr(expr, isList, out) {
    if (typeof expr !== 'string' || !expr.trim()) return;
    let ast;
    try { ast = parseExpr(expr, { host: TOPIC_HOST_SPEC }); } catch { return; }
    walkPaths(ast, (node, parent, key) => {
        if (isEmptinessUse(parent, key)) return;
        const tokens = segmentsToTokens(node.segments);
        if (!tokens || !tokens.length) return;
        const path = formatPath(tokens);
        const list = listBeforeWildcard(tokens) || (readsWholeList(isList, path) ? path : null);
        if (list && !out.some((r) => r.path === path)) out.push({ list, path });
    });
}

/** Does this step decide once for the whole run (a condition, or a switch without a list)? */
export function isWholeRunRoute(step) {
    if (!step || typeof step !== 'object') return false;
    if (step.type === 'condition') return true;
    return step.type === 'switch' && !(typeof step.arrayRef === 'string' && step.arrayRef.trim() !== '');
}

/**
 * The lists a whole-run condition/switch reads as a whole: every path with a
 * `[*]` in its rule(s) (`list` = the part before the first `[*]`), and, when
 * `isList(path)` says so, paths whose value is a list (not a list of plain
 * values, when `isList` returns the list). Emptiness checks are skipped. `[]`
 * for any other step.
 */
export function wholeRunListReads(step, isList) {
    if (!isWholeRunRoute(step)) return [];
    const out = [];
    readsOfExpr(step.expr, isList, out);
    for (const c of Array.isArray(step.cases) ? step.cases : []) if (c) readsOfExpr(c.expr, isList, out);
    return out;
}

/** The fields through which a step runs once per item of a list. */
function loopFields(step) {
    const fields = {};
    if (step.forEach && typeof step.forEach.overRef === 'string') fields.forEach = step.forEach.overRef;
    if (step.type === 'loop' && typeof step.overRef === 'string') fields.overRef = step.overRef;
    if (typeof step.arrayRef === 'string') fields.arrayRef = step.arrayRef;
    return fields;
}

/**
 * The steps right after whole-run route `condId` that still run once per item
 * of a list the route read as a whole: `{ stepId, reads }`, `reads` = that list.
 */
export function loopsAfterWholeRun(definition, condId, isList) {
    const steps = definition && Array.isArray(definition.steps) ? definition.steps : [];
    const route = steps.find((s) => s && s.id === condId);
    const lists = [...new Set(wholeRunListReads(route, isList).map((r) => r.list))].filter((l) => parsePath(l));
    if (!lists.length) return [];
    const out = [];
    const seen = new Set();
    for (const e of Array.isArray(definition.edges) ? definition.edges : []) {
        if (!e || e.from !== condId || e.label === 'on_error' || seen.has(e.to)) continue;
        seen.add(e.to);
        const target = steps.find((s) => s && s.id === e.to);
        if (!target) continue;
        const fields = loopFields(target);
        const reads = lists.find((list) => stepReadsPath(fields, list));
        if (reads) out.push({ stepId: target.id, reads });
    }
    return out;
}
