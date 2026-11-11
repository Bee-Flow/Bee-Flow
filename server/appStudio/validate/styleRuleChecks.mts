/**
 * App Studio validator: conditional style (package LK15), node.styleWhen and the cellStyle of a
 * table or data_grid column.
 *
 * The stored list must be exactly what the canonicalizer keeps (each repair it would make is an
 * error: canonical bytes handed in directly), and every rule's formula is checked the way every
 * node condition is (it parses, its roots exist, its `vars.` reads count). The cellStyle SHAPE is
 * checked with the other object keys of a column (objectChecks.mts); only its formulas are here.
 */

import { createRequire } from 'node:module';
import { shapeProblems } from '../../shared/format/formatClean.mjs';
import type { Finding } from '../definitionKeyRegistry.mts';

type Obj = Record<string, unknown>;
type Push = (code: string, path: string, message: string) => void;
interface RuleCheckCtx { pushE: (f: Finding) => void; pushW: (f: Finding) => void }

const nodeRequire = createRequire(import.meta.url);
const { validateFormula } = nodeRequire('./formulas.js') as {
    validateFormula: (expr: unknown, path: string, ctx: object, roots: readonly string[]) => void;
};
const { FORMULA_SCOPE_ROOTS } = nodeRequire('../componentSpecs.js') as { FORMULA_SCOPE_ROOTS: readonly string[] };
const { cleanStyleWhen } = nodeRequire('../canonicalize/styleWhen.mts') as {
    cleanStyleWhen: (raw: unknown, type: unknown, path: string, push: Push) => unknown;
};

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** validateFormula on the `when` of every rule of a list. */
function checkRuleFormulas(rules: unknown, path: string, ctx: RuleCheckCtx): void {
    if (!Array.isArray(rules)) return;
    rules.forEach((rule, i) => {
        const when = isObject(rule) ? rule.when : undefined;
        if (isObject(when) && when.kind === 'formula') validateFormula(when.expr, `${path}[${i}].when.expr`, ctx, FORMULA_SCOPE_ROOTS);
    });
}

/** Findings for one node's styleWhen and its columns' cellStyle formulas. */
export function checkStyleRules(node: Obj, path: string, ctx: RuleCheckCtx): void {
    if (node.styleWhen !== undefined) {
        const at = `${path}.styleWhen`;
        const clean: (raw: unknown, push: Push, p: string) => unknown = (raw, push, p) => cleanStyleWhen(raw, node.type, p, push);
        for (const problem of shapeProblems(node.styleWhen, clean, at)) {
            ctx.pushE({
                code: 'node.style_when_invalid', severity: 'error', path: problem.path, message: problem.message,
                hint: 'Each rule is { when: { kind: "formula", expr }, style: { <look knob of this type>: <value> } }; run the definition through canonicalize to drop what cannot be used.',
            });
        }
        checkRuleFormulas(node.styleWhen, at, ctx);
    }
    const columns = isObject(node.props) ? node.props.columns : undefined;
    if (!Array.isArray(columns)) return;
    columns.forEach((col, i) => {
        if (isObject(col) && col.cellStyle !== undefined) checkRuleFormulas(col.cellStyle, `${path}.props.columns[${i}].cellStyle`, ctx);
    });
}
