/**
 * Shapes recognised in Windmill JavaScript and TypeScript, on the syntax tree:
 * nothing here runs imported code, and nothing matches the source text with a
 * regular expression.
 *
 *   rawPath(expr)            `flow_input.event.node.id` (optional chaining allowed) as a dotted path, or null
 *   findTitleLiteral(expr)   the "T" of `x.find(c => c.title === "T")?.id`, or null
 *   resumeTest(expr)         `resume?.error` / `!resume?.error`: which approval outcome a branch tests
 *   stripTypes(source)       TypeScript to JavaScript (esbuild `transformSync`, types only; nothing is bundled)
 *   parseModule(js)          an acorn Program in module mode, or null
 */

import * as acorn from 'acorn';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const esbuild = nodeRequire('esbuild') as { transformSync: (src: string, opts: Record<string, unknown>) => { code: string } };

export type AnyNode = acorn.Node & Record<string, unknown>;

function parseExpr(expr: string): AnyNode | null {
    try {
        const node = acorn.parseExpressionAt(expr, 0, { ecmaVersion: 'latest' }) as AnyNode;
        return expr.slice(node.end).trim() === '' ? node : null;
    } catch {
        return null;
    }
}

function chainText(node: AnyNode): string | null {
    let cur = node;
    const parts: string[] = [];
    for (;;) {
        if (cur.type === 'ChainExpression') { cur = cur.expression as AnyNode; continue; }
        if (cur.type === 'Identifier') { parts.push(cur.name as string); break; }
        if (cur.type !== 'MemberExpression' || cur.computed) return null;
        parts.push((cur.property as AnyNode).name as string);
        cur = cur.object as AnyNode;
    }
    return parts.reverse().join('.');
}

export function rawPath(expr: string): string | null {
    const node = parseExpr(expr);
    return node ? chainText(node) : null;
}

export function findTitleLiteral(expr: string): string | null {
    let node = parseExpr(expr);
    if (!node) return null;
    if (node.type === 'ChainExpression') node = node.expression as AnyNode;
    if (node.type !== 'MemberExpression' || node.computed || (node.property as AnyNode).name !== 'id') return null;
    const call = node.object as AnyNode;
    if (call.type !== 'CallExpression') return null;
    const callee = call.callee as AnyNode;
    if (callee.type !== 'MemberExpression' || (callee.property as AnyNode).name !== 'find') return null;
    return titleOfPredicate((call.arguments as AnyNode[])[0]);
}

/** The "T" of `c => c.title === "T"`, or null. */
function titleOfPredicate(fn: AnyNode | undefined): string | null {
    if (!fn || fn.type !== 'ArrowFunctionExpression' || (fn.params as AnyNode[]).length !== 1) return null;
    const param = ((fn.params as AnyNode[])[0]).name as string;
    const body = fn.body as AnyNode;
    if (body.type !== 'BinaryExpression' || (body.operator !== '===' && body.operator !== '==')) return null;
    const right = body.right as AnyNode;
    if (chainText(body.left as AnyNode) !== `${param}.title` || right.type !== 'Literal' || typeof right.value !== 'string') return null;
    return right.value;
}

/** Which approval outcome a branch expression tests, or null when it tests something else. */
export function resumeTest(expr: string): 'rejected' | 'approved' | null {
    const node = parseExpr(expr.trim());
    if (!node) return null;
    if (node.type === 'UnaryExpression' && node.operator === '!') {
        return chainText(node.argument as AnyNode) === 'resume.error' ? 'approved' : null;
    }
    return chainText(node) === 'resume.error' ? 'rejected' : null;
}

export function stripTypes(source: string): { code: string } | { error: string } {
    try {
        const out = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022', sourcemap: false, legalComments: 'none' });
        return { code: out.code };
    } catch (e) {
        const first = e instanceof Error ? e.message.split('\n')[0] : String(e);
        return { error: first };
    }
}

export function parseModule(js: string): AnyNode | null {
    try {
        return acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }) as unknown as AnyNode;
    } catch {
        return null;
    }
}

/** Depth-first visit of every node of a tree. */
export function walk(node: unknown, visit: (n: AnyNode, parent: AnyNode | null) => void, parent: AnyNode | null = null): void {
    if (!node || typeof node !== 'object') return;
    const n = node as AnyNode;
    const isNode = typeof n.type === 'string';
    if (isNode) visit(n, parent);
    const owner = isNode ? n : parent;
    for (const [k, v] of Object.entries(n)) {
        if (k === 'start' || k === 'end' || k === 'loc') continue;
        if (Array.isArray(v)) for (const c of v) walk(c, visit, owner);
        else if (isTree(v)) walk(v, visit, owner);
    }
}

function isTree(v: unknown): boolean {
    return !!v && typeof v === 'object' && typeof (v as AnyNode).type === 'string';
}
