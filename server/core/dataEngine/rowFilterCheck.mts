/**
 * ROW-LEVEL-SECURITY: what a `rowFilters[role]` entry is checked for when a
 * data model is saved, and which rule of it an operation gets.
 *
 * Moved out of accessFilter.js, which describes the whole and re-exports
 * everything here; callers keep requiring that.
 *
 *   validateRowFilter(ruleOrPerOperation, tableMeta) → { ok, errors }
 *   rowFilterWarnings(ruleOrPerOperation, tableMeta) → string[] (advice, never a refusal)
 *   rowFilterForAction(entry, action) → the rule of one operation (its own, else the read rule), or none
 */

import { createRequire } from 'node:module';
import { reject, normalizeAst, plainPath, rowFilterToSql, LIST_ATTRIBUTES, KNOWN_ATTRIBUTES } from './rowFilterSql.mts';
import type { RowFilterNode, RuleTableMeta } from './rowFilterSql.mts';

const nodeRequire = createRequire(import.meta.url);
const { ROW_FILTER_OPERATIONS } = nodeRequire('./dataModel/vocabulary') as { ROW_FILTER_OPERATIONS: readonly string[] };

type Findings = { errors: string[]; warnings: string[] };
type PerOperation = Record<string, unknown>;

/**
 * What the SQL translation cannot say about a rule: a list attribute used as
 * one value (an error: it would never match), and advice about attributes.
 * `listAllowed` is true for the right side of `in`.
 */
function lintRowFilter(node: RowFilterNode | undefined, out: Findings, listAllowed = false): void {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'binop' || node.kind === 'unop') {
        lintRowFilter(node.a, out);
        lintRowFilter(node.b, out, node.op === 'in');
        return;
    }
    const p = plainPath(node);
    if (!p || p.root !== 'viewer') return;
    if (LIST_ATTRIBUTES.has(p.leaf)) {
        if (!listAllowed) out.errors.push(`viewer.${p.leaf} is a list: write record.<field> in viewer.${p.leaf}`);
    } else if (p.leaf === 'organizationId') {
        out.warnings.push('viewer.organizationId is not the same value everywhere (the session\'s organisation on data reads, the app\'s in server steps, empty on a public page): use viewer.orgId in a new rule');
    } else if (!KNOWN_ATTRIBUTES.has(p.leaf)) {
        out.warnings.push(`viewer.${p.leaf} is not something a row rule knows about the viewer, so it never matches (known: ${[...KNOWN_ATTRIBUTES].join(', ')})`);
    }
}

/** One rule (string or AST): it must translate, and it must pass the lint. */
function validateOneRule(astOrExpr: unknown, tableMeta: RuleTableMeta): Findings {
    const out: Findings = { errors: [], warnings: [] };
    try {
        rowFilterToSql(astOrExpr, {}, tableMeta);
        lintRowFilter(normalizeAst(astOrExpr), out);
    } catch (e) {
        out.errors.push(e instanceof Error ? e.message : String(e));
    }
    return out;
}

/** True for `{ read?, update?, delete? }`: an object that is neither an AST nor a list. */
function isPerOperation(entry: unknown): entry is PerOperation {
    return !!entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as { kind?: unknown }).kind !== 'string';
}

/** True for what a per-operation entry holds when an operation has no rule of its own. */
function isUnset(rule: unknown): boolean {
    return rule === null || rule === undefined || rule === '';
}

/**
 * The rule of one operation out of a `rowFilters[role]` entry. One rule (a
 * string or an AST) is that rule for every operation. A per-operation object
 * gives the rule under the operation's own key; an operation it leaves out
 * follows the rule for `read`, so changing or deleting is never broader than
 * seeing because a key is missing. An author who wants every row for one
 * operation writes the rule `true` for it. An object with a key that is not an
 * operation is refused rather than read as "no rule": a typo must not widen a
 * table.
 */
export function rowFilterForAction(entry: unknown, action: string): unknown {
    if (!isPerOperation(entry)) return entry;
    const stray = Object.keys(entry).find((k) => !ROW_FILTER_OPERATIONS.includes(k));
    if (stray !== undefined) throw reject(`"${stray}" is not a row rule operation (${ROW_FILTER_OPERATIONS.join(', ')})`);
    if (Object.hasOwn(entry, action) && !isUnset(entry[action])) return entry[action];
    return Object.hasOwn(entry, 'read') && !isUnset(entry.read) ? entry.read : null;
}

/**
 * Errors and warnings of a `rowFilters[role]` entry: one rule, or a rule per
 * operation (each message then starts with its operation).
 */
function checkRowFilter(entry: unknown, tableMeta: RuleTableMeta): Findings {
    if (!isPerOperation(entry)) return validateOneRule(entry, tableMeta);
    const errors: string[] = [];
    const warnings: string[] = [];
    const keys = Object.keys(entry);
    if (!keys.length) errors.push(`a rule per operation needs at least one of ${ROW_FILTER_OPERATIONS.join(', ')}`);
    for (const key of keys) {
        if (!ROW_FILTER_OPERATIONS.includes(key)) {
            errors.push(`"${key}" is not a row rule operation (${ROW_FILTER_OPERATIONS.join(', ')})`);
            continue;
        }
        const one = validateOneRule(entry[key], tableMeta);
        errors.push(...one.errors.map((m) => `${key}: ${m}`));
        warnings.push(...one.warnings.map((m) => `${key}: ${m}`));
    }
    return { errors, warnings };
}

/**
 * Validate a `rowFilters[role]` entry at data-model save time: one rule, or a
 * rule per operation. Returns { ok, errors }; the save path rejects a model
 * whose entries do not all pass. Structural only (an empty probe viewer); it
 * never executes.
 */
export function validateRowFilter(entry: unknown, tableMeta?: RuleTableMeta): { ok: boolean; errors: string[] } {
    const { errors } = checkRowFilter(entry, tableMeta);
    return { ok: errors.length === 0, errors };
}

/**
 * Advice about an entry that may well be valid (viewer.orgId over
 * viewer.organizationId, an attribute the viewer does not have): for the save
 * path to show, never a reason to refuse.
 */
export function rowFilterWarnings(entry: unknown, tableMeta?: RuleTableMeta): string[] {
    return checkRowFilter(entry, tableMeta).warnings;
}
