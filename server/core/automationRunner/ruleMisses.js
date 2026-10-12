/**
 * Rule misses: a path in a Condition, Filter or Switch rule that found
 * nothing on any of the items the rule was asked about.
 *
 * A typo in a rule (`item.atachments`) used to fail silently: the rule was
 * false for every item, the filter kept nothing, and the run stayed green.
 * Mapping misses already land in the binding log (automation/bind.js); a rule
 * miss now lands there too, as one entry `{ kind: 'rule', path, reason, at,
 * found, missing, count, field? }`, so the run panel lists it under
 * "Mappings that found nothing".
 *
 * Only a path that missed on EVERY item is recorded: a field that some items
 * have and others lack is ordinary data, not a mistake. For a list column
 * (`item.attachments[*].mimeType`) an item counts only when its list part is
 * a non-empty list: the column missing on all of its elements is a miss, an
 * empty or absent list says nothing about the column. A list part that is
 * itself absent is a miss of the path.
 *
 * Paths are read from the parsed rule, never evaluated: `item.a && item.b`
 * still checks `item.b` when `item.a` is false for every item.
 *
 * Some places in a rule are written for a field that may be absent: the one
 * argument of isEmpty/len/count, the operand of `!`, a bare truthy test (the
 * whole rule, an operand of `&&`/`||`, the condition of `?:`). A path only
 * read there is "tolerant": it is recorded only when the rule matched nothing
 * (`report(..., { matched })`), since a rule that kept items did what it was
 * written for (`isEmpty(item.cc)` on mails without cc). The left side of
 * `a || b` is a fallback and never recorded on its own, as for a mapping
 * formula (bind.js logs only when the whole value is empty). A `steps.<id>`
 * path whose step has not run in this run (skipped branch) is not counted:
 * its absence says nothing about a typo.
 */
'use strict';

const { formatPath, walkTokens } = require('../../automation/expr');
const { noteRuleMiss } = require('../../automation/bind');

const RULE_ROOTS = new Set(['item', 'loop', 'steps', 'trigger']);

/**
 * AST path segments → path tokens: name → prop, a literal index → prop,
 * wildcard → wild, match → match. Stops at a computed index (its value is
 * only known while evaluating), so the tokens name the part before it.
 */
function tokenOf(s) {
    switch (s.kind) {
        case 'name': return { type: 'prop', key: s.v };
        case 'wildcard': return { type: 'wild' };
        case 'match': return { type: 'match', key: s.key, value: s.value };
        case 'index': {
            const literal = s.expr && (s.expr.kind === 'str' || s.expr.kind === 'num');
            return literal ? { type: 'prop', key: s.expr.v } : null;
        }
        default: return null;
    }
}

function segmentsToTokens(segments) {
    const tokens = [];
    for (const s of segments) {
        const t = tokenOf(s);
        if (!t) break;
        tokens.push(t);
    }
    return tokens;
}

const EMPTINESS_FNS = new Set(['isEmpty', 'len', 'count']);

/**
 * How a path node in this position reads its field: 'fallback' (the left of
 * `||`: the right side supplies the value), 'tolerant' (a check written for
 * an absent field) or 'strict'. Mirrors shared/expr/wholeRun.mjs isEmptinessUse.
 */
function useOf(parent, key) {
    if (!parent) return 'tolerant';
    if (parent.kind === 'binop' && parent.op === '||') return key === 'a' ? 'fallback' : 'tolerant';
    if (parent.kind === 'binop' && parent.op === '&&') return 'tolerant';
    if (parent.kind === 'unop' && parent.op === '!') return 'tolerant';
    if (parent.kind === 'ternary' && key === 'cond') return 'tolerant';
    const emptiness = parent.kind === 'call' && EMPTINESS_FNS.has(parent.name) && parent.args.length === 1;
    return emptiness ? 'tolerant' : 'strict';
}

function collectPaths(node, out, parent = null, key = null) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'path' && Array.isArray(node.segments)) {
        const tokens = segmentsToTokens(node.segments);
        if (tokens.length > 1 && RULE_ROOTS.has(tokens[0].key)) out.push({ tokens, use: useOf(parent, key) });
        for (const s of node.segments) if (s.expr) collectPaths(s.expr, out);
        return;
    }
    for (const k of ['cond', 'a', 'b', 'expr']) if (node[k]) collectPaths(node[k], out, node, k);
    if (Array.isArray(node.args)) for (const arg of node.args) collectPaths(arg, out, node, 'args');
}

const USE_RANK = { fallback: 0, tolerant: 1, strict: 2 };

/**
 * Every path a rule reads that is rooted at `item`, `loop`, `steps` or
 * `trigger`, once each, in source order. `use` is the strictest of its
 * occurrences: 'strict', 'tolerant' or 'fallback' (see useOf).
 * @returns {Array<{ path: string, tokens: object[], use: string }>}
 */
function rulePaths(ast) {
    const found = [];
    collectPaths(ast, found);
    const byPath = new Map();
    for (const { tokens, use } of found) {
        const path = formatPath(tokens);
        const prev = byPath.get(path);
        if (!prev) byPath.set(path, { path, tokens, use });
        else if (USE_RANK[use] > USE_RANK[prev.use]) prev.use = use;
    }
    return [...byPath.values()];
}

/** One rule path's tally: how many items it found something on, and missed on. */
function newTally(path, tokens, field, use) {
    const wild = tokens.findIndex((t) => t.type === 'wild');
    const column = wild > 0 ? tokens.slice(wild + 1) : [];
    return {
        path, tokens, field, use,
        listTokens: column.length ? tokens.slice(0, wild) : null,
        column,
        hits: 0, misses: 0, missScope: null, missList: null,
    };
}

/** A `steps.<id>` path whose step has no entry in this run (not run, or skipped). */
function stepNotRun(tokens, scope) {
    if (tokens[0].key !== 'steps' || tokens[1].type !== 'prop') return false;
    const steps = scope && scope.steps;
    return !steps || typeof steps !== 'object' || !Object.prototype.hasOwnProperty.call(steps, tokens[1].key);
}

/** 'hit' | 'miss' | 'neutral' for one tally on one scope. */
function observeOne(t, scope) {
    if (stepNotRun(t.tokens, scope)) return 'neutral';
    if (!t.listTokens) return walkTokens(t.tokens, scope) === undefined ? 'miss' : 'hit';
    if (walkTokens(t.listTokens, scope) === undefined) return 'miss';
    const list = walkTokens([...t.listTokens, { type: 'wild' }], scope);
    if (!Array.isArray(list) || !list.length) return 'neutral';
    for (const el of list) if (walkTokens(t.column, el) !== undefined) return 'hit';
    t.missList = t.missList || list;
    return 'miss';
}

/**
 * Where a list column stopped: the deepest part of the column that some
 * element of `list` has. Overrides bind.analyseMiss, which would read the
 * flattened list instead of one element.
 */
function columnStop(t) {
    const base = [...t.listTokens, { type: 'wild' }];
    for (let n = t.column.length - 1; n >= 0; n--) {
        const part = t.column.slice(0, n);
        if (n > 0 && !t.missList.some((el) => walkTokens(part, el) !== undefined)) continue;
        const next = t.column[n];
        return {
            reason: 'missing',
            at: formatPath([...base, ...part]),
            found: 'record',
            missing: next.type === 'prop' ? String(next.key) : formatPath([next]),
            size: undefined,
            index: undefined,
        };
    }
    return {};
}

/** Is this tally worth recording, given how many items its rule matched? */
function shouldReport(t, matched) {
    if (t.hits || !t.misses || t.use === 'fallback') return false;
    if (t.use === 'strict') return true;
    const n = matched && typeof matched === 'object' ? matched[t.field] : matched;
    return !(Number(n) > 0); // tolerant: only when the rule matched nothing (or unknown)
}

/**
 * A counter for the rules of one step.
 * @param {Array<{ ast: object|null, field?: string }>} entries one per rule
 *   (a switch passes one per case, `field` = the case name)
 * @returns {{ observe(scope: object): void, report(total: number, sampleScope?: object, opts?: { matched?: number|Record<string, number> }): void }}
 *   `matched`: how many items the rule kept (a number), or per case name for a
 *   switch. Left out, every tolerant path is reported as before.
 */
function createRuleMissCounter(entries) {
    const tallies = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || !e.ast) continue;
        for (const { path, tokens, use } of rulePaths(e.ast)) tallies.push(newTally(path, tokens, e.field || null, use));
    }
    return {
        observe(scope) {
            for (const t of tallies) {
                if (t.hits) continue;
                const seen = observeOne(t, scope);
                if (seen === 'hit') t.hits += 1;
                else if (seen === 'miss') {
                    t.misses += 1;
                    if (!t.missScope) t.missScope = scope;
                }
            }
        },
        report(total, sampleScope = null, { matched } = {}) {
            if (!total) return;
            for (const t of tallies) {
                if (!shouldReport(t, matched)) continue;
                const extra = { count: t.misses, ...(t.field ? { field: t.field } : {}) };
                if (t.missList) Object.assign(extra, columnStop(t));
                noteRuleMiss(t.path, t.missScope || sampleScope, extra);
            }
        },
    };
}

module.exports = { rulePaths, createRuleMissCounter };
