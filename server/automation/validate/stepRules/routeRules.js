/**
 * Rules about what a Condition / Filter / Switch reads and what reads it.
 *
 *   route.reads_source        (warning, on the successor) a step hanging
 *                             directly off a list-mode Condition still reads
 *                             the Condition's source list and none of its
 *                             outputs: what the Condition drops reaches it.
 *   route.item_field_unknown  (warning, on the route) a rule reads `item.<k>`
 *                             (or a column `item.<l>[*].<c>`) that the sample
 *                             items do not have, while one of their keys is a
 *                             near miss. Silent without such a candidate.
 *   condition.list_compare    (warning) startsWith/endsWith or == / != on a
 *                             `[*]` path compares a whole list as one text.
 *   condition.quantifier_test_unknown (error) anyOf/everyOf/noneOf with a
 *                             test that does not exist or the wrong number of
 *                             arguments: the run would fail on every item.
 *   condition.whole_list      (warning, on a whole-run Condition) it reads a
 *                             list as a whole: the run goes one way for all
 *                             items, nothing is filtered (BFSF-485).
 *   condition.loop_not_filtered (warning, on the successor) a step right
 *                             after such a Condition still runs once per item
 *                             of that list (BFSF-485).
 *
 * The sample items come from the source step's pinned output, else the
 * curated sample of an integration tool (outputSchemas.js). The graph-wide
 * findings are computed once per graph (WeakMap keyed by the graph) and only
 * for top-level steps: bodies have no edges.
 */

const {
    parseExpr, TOPIC_HOST_SPEC, parsePath, getList, TEST_OF_OP, UNARY_TESTS,
    staleSuccessors, isListRoute, wholeRunListReads, loopsAfterWholeRun,
} = require('../../expr');
const { OUTPUT_SCHEMAS } = require('../../outputSchemas');
const { isObject, levenshtein } = require('../helpers');
const { rulePaths } = require('../../../core/automationRunner/ruleMisses');

const TOPICS = { host: TOPIC_HOST_SPEC };
const QUANTIFIERS = new Set(['anyOf', 'everyOf', 'noneOf']);
const TEST_NAMES = Object.values(TEST_OF_OP);
const COMPARE_OPS = new Set(['==', '!=', '===', '!==']);
const ENDS_FNS = new Set(['startsWith', 'endsWith']);
const SAMPLE_ROWS = 20;

// One entry per validation pass; see findingsFor.
const graphFindings = new WeakMap();

// ── Samples ─────────────────────────────────────────────────────────────

const topSteps = (graph) => (Array.isArray(graph?.steps) ? graph.steps.filter((s) => isObject(s) && typeof s.id === 'string') : []);

/** The run-state root a path can be read against from samples alone, or null. */
function sampleRoot(graph, trigger, path) {
    const tokens = parsePath(String(path || ''));
    if (!tokens || !tokens.length) return null;
    if (tokens[0].key === 'trigger') {
        return trigger && trigger.pinnedOutput != null ? { trigger: { output: trigger.pinnedOutput } } : null;
    }
    if (tokens[0].key !== 'steps' || !tokens[1] || tokens[1].type !== 'prop') return null;
    const id = String(tokens[1].key);
    const src = topSteps(graph).find((s) => s.id === id);
    if (!src) return null;
    let output = src.pinnedOutput;
    if (output == null && typeof src.tool === 'string' && OUTPUT_SCHEMAS[src.tool]) output = OUTPUT_SCHEMAS[src.tool].sample;
    return output == null ? null : { steps: { [id]: { output } } };
}

/** The list `path` names in the samples, or null (wholeRun.mjs `isList`). */
function isListPathIn(graph, trigger) {
    // Returns the list itself (or null): wholeRun.mjs then skips a list of
    // plain values read whole (`contains(trigger.output.labels, "urgent")`),
    // a membership question about the run, not a filter the author forgot.
    return (path) => {
        const root = sampleRoot(graph, trigger, path);
        return root ? getList(root, path) : null;
    };
}

/** The keys the first records of a list carry, or null when it holds none. */
function keysOfRecords(list) {
    if (!Array.isArray(list)) return null;
    const keys = new Set();
    for (const row of list.slice(0, SAMPLE_ROWS)) if (isObject(row)) for (const k of Object.keys(row)) keys.add(k);
    return keys.size ? keys : null;
}

/** A key of `keys` that `key` is a near miss of: same but for case, else edit distance <= 2. */
function nearKey(key, keys) {
    if (keys.has(key)) return null;
    const lower = key.toLowerCase();
    for (const k of keys) if (k.toLowerCase() === lower) return k;
    let best = null;
    let bestDist = 3;
    for (const k of keys) {
        const d = levenshtein(lower, k.toLowerCase());
        if (d < bestDist) { best = k; bestDist = d; }
    }
    return best;
}

// ── Rule texts ──────────────────────────────────────────────────────────

/** Every rule text of a route-like step, with where it sits. */
function ruleTexts(step) {
    const out = [];
    if ((step.type === 'condition' || step.type === 'filter') && typeof step.expr === 'string') out.push({ expr: step.expr, at: '.expr' });
    if (step.type === 'switch' && Array.isArray(step.cases)) {
        step.cases.forEach((c, i) => { if (isObject(c) && typeof c.expr === 'string') out.push({ expr: c.expr, at: `.cases[${i}].expr` }); });
    }
    return out;
}

function parsed(expr) {
    try { return parseExpr(expr, TOPICS); } catch { return null; }
}

/** Visit every node of an AST. */
function walkAst(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const k of ['cond', 'a', 'b', 'expr']) if (node[k]) walkAst(node[k], visit);
    if (Array.isArray(node.args)) for (const a of node.args) walkAst(a, visit);
    if (Array.isArray(node.segments)) for (const s of node.segments) if (s.expr) walkAst(s.expr, visit);
}

/** The path text of a path node that holds a `[*]`, else null. */
function wildPathText(node) {
    if (!node || node.kind !== 'path') return null;
    const paths = rulePaths(node);
    const p = paths.find((x) => x.tokens.some((t) => t.type === 'wild'));
    return p ? p.path : null;
}

const literalText = (node) => (node && node.kind === 'str' ? JSON.stringify(node.v) : (node && node.kind === 'num' ? String(node.v) : '<value>'));

// ── route.item_field_unknown ────────────────────────────────────────────

/** The near-miss finding for one `item…` path, or null. */
function fieldFinding(tokens, items) {
    const [, first, wild, column] = tokens;
    if (!first || first.type !== 'prop' || typeof first.key !== 'string') return null;
    const itemKeys = keysOfRecords(items);
    if (!itemKeys) return null;
    if (!itemKeys.has(first.key)) {
        const near = nearKey(first.key, itemKeys);
        return near ? { read: first.key, near } : null;
    }
    if (!wild || wild.type !== 'wild' || !column || column.type !== 'prop' || typeof column.key !== 'string') return null;
    const inner = keysOfRecords(items.slice(0, SAMPLE_ROWS).flatMap((row) => (isObject(row) && Array.isArray(row[first.key]) ? row[first.key] : [])));
    if (!inner) return null;
    const near = inner.has(column.key) ? null : nearKey(column.key, inner);
    return near ? { read: `${first.key}[*].${column.key}`, near: `${first.key}[*].${near}` } : null;
}

function checkRuleFields(ctx, step, at) {
    if (!isListRoute(step)) return;
    const root = sampleRoot(ctx.graph, ctx.trigger, step.arrayRef);
    const items = root ? getList(root, step.arrayRef) : null;
    if (!items || !items.length) return;
    for (const { expr, at: where } of ruleTexts(step)) {
        const ast = parsed(expr);
        if (!ast) continue;
        for (const { tokens } of rulePaths(ast)) {
            if (tokens[0].key !== 'item') continue;
            const f = fieldFinding(tokens, items);
            if (!f) continue;
            ctx.pushW({
                code: 'route.item_field_unknown', severity: 'warning', path: at + where,
                message: `Step ${step.id}: the rule reads item.${f.read}, but the items of ${step.arrayRef} have no "${f.read}" — did you mean “${f.near}”?`,
                hint: `Read item.${f.near} instead; as written the rule matches nothing.`,
            });
        }
    }
}

// ── condition.list_compare / condition.quantifier_test_unknown ──────────

function quantifierProblem(node) {
    const [, testArg] = node.args;
    if (!testArg || testArg.kind !== 'str' || !TEST_NAMES.includes(testArg.v)) {
        const typed = testArg && testArg.kind === 'str' ? testArg.v : null;
        const near = typed ? TEST_NAMES.find((t) => t.toLowerCase() === typed.toLowerCase()) : null;
        return {
            message: `${node.name}(…) needs a test as its second argument, in quotes: ${TEST_NAMES.join(', ')}${typed !== null ? ` — "${typed}" is not one` : ''}.`,
            hint: near ? `Did you mean "${near}"? Tests are case-sensitive.` : `For example ${node.name}(item.attachments[*].filename, "endsWith", ".pdf").`,
        };
    }
    const unary = UNARY_TESTS.includes(testArg.v);
    const want = unary ? 2 : 3;
    if (node.args.length === want) return null;
    return unary
        ? { message: `${node.name}(…, "${testArg.v}") takes no value to compare with.`, hint: `Write ${node.name}(<list>, "${testArg.v}").` }
        : { message: `${node.name}(…, "${testArg.v}", <value>) needs exactly one value to compare with.`, hint: `Write ${node.name}(<list>, "${testArg.v}", <value>).` };
}

function listCompareProblem(node) {
    if (node.kind === 'call' && ENDS_FNS.has(node.name)) {
        const path = wildPathText(node.args[0]);
        if (!path) return null;
        return { path, hint: `To check each entry write anyOf(${path}, "${node.name}", ${literalText(node.args[1])}).` };
    }
    if (node.kind === 'binop' && COMPARE_OPS.has(node.op)) {
        const left = wildPathText(node.a);
        const path = left || wildPathText(node.b);
        if (!path) return null;
        const test = node.op.startsWith('!') ? '!=' : '==';
        return { path, hint: `To check each entry write anyOf(${path}, "${test}", ${literalText(left ? node.b : node.a)}).` };
    }
    return null;
}

function checkRuleShapes(ctx, step, at) {
    for (const { expr, at: where } of ruleTexts(step)) {
        const ast = parsed(expr);
        if (!ast) continue;
        walkAst(ast, (node) => {
            if (node.kind === 'call' && QUANTIFIERS.has(node.name)) {
                const p = quantifierProblem(node);
                if (p) ctx.pushE({ code: 'condition.quantifier_test_unknown', severity: 'error', path: at + where, message: `Step ${step.id}: ${p.message}`, hint: p.hint });
                return;
            }
            const lc = listCompareProblem(node);
            if (lc) {
                ctx.pushW({
                    code: 'condition.list_compare', severity: 'warning', path: at + where,
                    message: `Step ${step.id}: the rule compares the whole list ${lc.path} as one text: only the first/last entry counts.`,
                    hint: lc.hint,
                });
            }
        });
    }
}

// ── Graph-wide: route.reads_source, condition.loop_not_filtered ─────────

/** A whole-run route the BFSF-485 findings apply to: a Condition, or a rules-only Switch. */
function isWholeRunRule(step) {
    if (step.type === 'condition') return true;
    return step.type === 'switch' && !(typeof step.arrayRef === 'string' && step.arrayRef.trim())
        && !(typeof step.expr === 'string' && step.expr.trim());
}

function computeGraphFindings(graph, trigger) {
    const bySuccessor = new Map();
    const add = (id, f) => { if (!bySuccessor.has(id)) bySuccessor.set(id, []); bySuccessor.get(id).push(f); };
    const isList = isListPathIn(graph, trigger);
    const steps = topSteps(graph);
    for (const s of steps) {
        if (isListRoute(s)) {
            for (const st of staleSuccessors(graph, s.id)) add(st.stepId, { kind: 'stale', route: s, ...st });
        } else if (isWholeRunRule(s)) {
            for (const lp of loopsAfterWholeRun(graph, s.id, isList)) add(lp.stepId, { kind: 'loop', route: s, ...lp });
        }
    }
    return bySuccessor;
}

// Keyed by the step index of this validation pass (a new Map per pass), not
// by the graph itself: the AI builder edits its draft in place and validates
// it again, and a finding cached on the graph object would outlive the edit.
function findingsFor(ctx) {
    const graph = ctx.graph;
    if (!isObject(graph)) return new Map();
    const key = ctx.stepsById instanceof Map ? ctx.stepsById : graph;
    if (!graphFindings.has(key)) graphFindings.set(key, computeGraphFindings(graph, ctx.trigger));
    return graphFindings.get(key);
}

const nameOf = (s) => (typeof s.label === 'string' && s.label.trim() ? s.label.trim() : s.id);

function checkRouteReads(ctx, step, at) {
    if (ctx.nested) return;
    for (const f of findingsFor(ctx).get(step.id) || []) {
        if (f.kind === 'stale') {
            ctx.pushW({
                code: 'route.reads_source', severity: 'warning', path: at,
                message: `Step ${step.id} comes right after ${f.route.id} but still reads its source list ${f.reads}, so what ${f.route.id} drops still reaches it.`,
                hint: `Read ${f.to} instead: that is what ${f.route.id} keeps for this output.`,
            });
        } else {
            ctx.pushW({
                code: 'condition.loop_not_filtered', severity: 'warning', path: at,
                message: `“${nameOf(step)}” runs once per item of ${f.reads}, but the Condition before it checked that list as a whole: every item still reaches this step.`,
                hint: 'Make the Condition work through the list (one output = Filter) and loop over its output.items.',
            });
        }
    }
}

// ── condition.whole_list ────────────────────────────────────────────────

function checkWholeList(ctx, step, at) {
    if (!isObject(step) || !isWholeRunRule(step)) return;
    const lists = [...new Set(wholeRunListReads(step, isListPathIn(ctx.graph, ctx.trigger)).map((r) => r.list))];
    for (const list of lists) {
        ctx.pushW({
            code: 'condition.whole_list', severity: 'warning', path: at + (step.type === 'condition' ? '.expr' : '.cases'),
            message: `Step ${step.id}: This Condition checks the whole list ${list} once and sends the whole run one way; it does not filter the items.`,
            hint: 'To keep only the matching items, make it work through the list (one output = Filter).',
        });
    }
}

/** Every route rule, in a fixed order. Registered after checkSwitch. */
function checkRoutes(ctx, step, at) {
    if (!isObject(step)) return;
    checkRouteReads(ctx, step, at);
    checkRuleFields(ctx, step, at);
    checkRuleShapes(ctx, step, at);
    checkWholeList(ctx, step, at);
}

module.exports = { checkRoutes, checkRouteReads, checkRuleFields, checkRuleShapes, checkWholeList };
