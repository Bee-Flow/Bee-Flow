/**
 * The reference surfaces of a table step's operations, for refSurfaces.js
 * (collectStepRefs).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { isObject, collectRefPaths, rootOf } = nodeRequire('../helpers') as {
    isObject(v: unknown): v is Record<string, any>;
    collectRefPaths(value: unknown, out: any[], where?: string): void;
    rootOf(path: string): string;
};

// The roots that exist only while a table step runs one row.
const ROW_ROOTS = new Set(['row', 'rowIndex']);

/**
 * The references of a table step's operations: the table joined in, the rules
 * a filter reads from run data, the values a rule compares with and what a
 * derived column is made of. A derived value or a filter formula reads the
 * row being worked on as `row` (and its position as `rowIndex`); those roots
 * are not run data, so a path that starts with one is not reported. A formula
 * in a derive value is parse-checked here (binding: true); a filter's own
 * formula is not a binding, so it is checked with parse: true.
 */
export function collectTableOpRefs(step: any, refs: any[]): void {
    (Array.isArray(step.ops) ? step.ops : []).forEach((op: any, i: number) => {
        if (!isObject(op)) return;
        const at = `ops[${i}]`;
        const from = refs.length;
        if (op.op === 'join') collectRefPaths(op.with, refs, `${at}.with`);
        if (op.op === 'filter') {
            collectRefPaths(op.rulesFrom, refs, `${at}.rulesFrom`);
            (Array.isArray(op.rules) ? op.rules : []).forEach((r: any, j: number) => {
                if (isObject(r)) collectRefPaths(r.value, refs, `${at}.rules[${j}].value`);
            });
            if (typeof op.expr === 'string' && op.expr) refs.push({ kind: 'expr', src: op.expr, where: `${at}.expr`, parse: true });
        }
        if (op.op === 'derive') {
            (Array.isArray(op.columns) ? op.columns : []).forEach((c: any, j: number) => {
                if (isObject(c)) collectRefPaths(c.value, refs, `${at}.columns[${j}].value`);
            });
        }
        // The row roots are not run data: drop the paths that start with one.
        for (let k = refs.length - 1; k >= from; k--) {
            if (refs[k].kind === 'ref' && ROW_ROOTS.has(rootOf(refs[k].path))) refs.splice(k, 1);
        }
    });
}
