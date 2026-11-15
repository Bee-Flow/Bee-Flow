/**
 * Method and function calls in a Windmill expression, as Bee Flow expression
 * functions (part of mapExpr.mts): `.filter/.map/.some/.every(x => …)`,
 * `.find(x => x.k === v)`, the string methods with a direct counterpart, and
 * `String() Number() Math.*() Object.keys/values()`. Every other call is refused.
 */

import type { Ctx, Node, Out } from './exprTypes.mts';
import { Unsupported, chainOf, snippet } from './exprTypes.mts';

// ── Calls ────────────────────────────────────────────────────────────────

const STRING_METHODS = new Map<string, { fn: string; args: number[] }>([
    ['split', { fn: 'split', args: [1] }],
    ['join', { fn: 'join', args: [1] }],
    ['trim', { fn: 'trim', args: [0] }],
    ['toLowerCase', { fn: 'lower', args: [0] }],
    ['toUpperCase', { fn: 'upper', args: [0] }],
    ['replaceAll', { fn: 'replace', args: [2] }],
    ['toString', { fn: 'toStr', args: [0] }],
]);

const EACH = new Set(['filter', 'map', 'some', 'every']);

const GLOBAL_CALLS = new Map<string, string>([
    ['String', 'toStr'], ['Number', 'number'],
    ['Math.round', 'round'], ['Math.floor', 'floor'], ['Math.ceil', 'ceil'], ['Math.abs', 'abs'],
    ['Math.min', 'min'], ['Math.max', 'max'],
    ['Object.keys', 'keys'], ['Object.values', 'values'],
]);

export function emitCall(node: Node, ctx: Ctx): Out {
    const callee = node.callee as Node;
    const args = node.arguments as Node[];
    if (args.some((a) => a.type === 'SpreadElement')) throw new Unsupported('A spread argument is not translated.');
    const global = globalName(callee);
    if (global !== null) return emitGlobalCall(global, args, ctx);
    if (callee.type !== 'MemberExpression' || callee.computed) throw new Unsupported(`The call "${snippet(node, ctx)}" is not translated.`);
    const method = (callee.property as Node).name as string;
    const target = callee.object as Node;
    if (EACH.has(method)) return emitEach(method, target, args, ctx);
    if (method === 'find') return emitFind(target, args, ctx);
    const known = STRING_METHODS.get(method);
    if (!known || !known.args.includes(args.length)) throw new Unsupported(`The method ".${method}()" is not translated.`);
    const parts = [ctx.emit(target, ctx).dsl, ...args.map((a) => ctx.emit(a, ctx).dsl)];
    return { dsl: `${known.fn}(${parts.join(', ')})`, atomic: true };
}

function globalName(callee: Node): string | null {
    if (callee.type === 'Identifier') return GLOBAL_CALLS.has(callee.name as string) ? callee.name as string : null;
    if (callee.type === 'MemberExpression' && !callee.computed && (callee.object as Node).type === 'Identifier') {
        const name = `${(callee.object as Node).name}.${(callee.property as Node).name}`;
        return GLOBAL_CALLS.has(name) ? name : null;
    }
    return null;
}

function emitGlobalCall(name: string, args: Node[], ctx: Ctx): Out {
    const fn = GLOBAL_CALLS.get(name) as string;
    const single = name === 'String' || name === 'Number' || name.startsWith('Object.') || ['Math.round', 'Math.floor', 'Math.ceil', 'Math.abs'].includes(name);
    if (single && args.length !== 1) throw new Unsupported(`${name}() with ${args.length} arguments is not translated.`);
    if (!single && args.length < 1) throw new Unsupported(`${name}() without arguments is not translated.`);
    // String(null) is "null" and Number("") is 0 in JavaScript; toStr / number answer "" and nothing.
    if (name === 'String' || name === 'Number') ctx.medium = true;
    return { dsl: `${fn}(${args.map((a) => ctx.emit(a, ctx).dsl).join(', ')})`, atomic: true };
}

function arrowBody(arg: Node | undefined, ctx: Ctx): { param: string; body: Node } {
    if (!arg || arg.type !== 'ArrowFunctionExpression') throw new Unsupported('Only an arrow function "x => …" is translated as a list predicate.');
    if (ctx.it !== null) throw new Unsupported('A list function inside another one is not translated (there is only one "it").');
    const params = arg.params as Node[];
    if (params.length !== 1 || params[0].type !== 'Identifier') throw new Unsupported('The arrow function must take exactly one plain parameter.');
    if (arg.expression !== true) throw new Unsupported('Only an arrow function with an expression body is translated.');
    return { param: params[0].name as string, body: arg.body as Node };
}

function withIt<T>(ctx: Ctx, param: string, fn: () => T): T {
    const prev = ctx.it;
    ctx.it = param;
    try { return fn(); } finally { ctx.it = prev; }
}

function emitEach(method: string, target: Node, args: Node[], ctx: Ctx): Out {
    if (args.length !== 1) throw new Unsupported(`.${method}() with an index or a this-argument is not translated.`);
    const list = ctx.emit(target, ctx).dsl;
    const { param, body } = arrowBody(args[0], ctx);
    const inner = withIt(ctx, param, () => ctx.emit(body, ctx).dsl);
    return { dsl: `${method}(${list}, ${inner})`, atomic: true };
}

function emitFind(target: Node, args: Node[], ctx: Ctx): Out {
    if (args.length !== 1) throw new Unsupported('.find() with a this-argument is not translated.');
    const list = ctx.emit(target, ctx).dsl;
    const { param, body } = arrowBody(args[0], ctx);
    const eq = equalityOnField(body, param);
    if (eq) {
        const value = ctx.emit(eq.other, ctx);
        if (!readsParam(eq.other, param)) return { dsl: `find(${list}, ${JSON.stringify(eq.key)}, ${value.dsl})`, atomic: true };
    }
    const inner = withIt(ctx, param, () => ctx.emit(body, ctx).dsl);
    return { dsl: `filter(${list}, ${inner})[0]`, atomic: true };
}

/** `p.key === other` (either side): the key and the other side. */
function equalityOnField(body: Node, param: string): { key: string; other: Node } | null {
    if (body.type !== 'BinaryExpression' || (body.operator !== '===' && body.operator !== '==')) return null;
    for (const [a, b] of [[body.left, body.right], [body.right, body.left]] as Array<[Node, Node]>) {
        const chain = chainOf(a);
        if (chain && chain.root === param && chain.segs.length === 1 && chain.segs[0].kind !== 'index') return { key: String(chain.segs[0].v), other: b };
    }
    return null;
}

function readsParam(node: Node, param: string): boolean {
    let found = false;
    const visit = (n: unknown): void => {
        if (found || !n || typeof n !== 'object') return;
        const o = n as Record<string, unknown>;
        if (o.type === 'Identifier' && o.name === param) { found = true; return; }
        for (const [k, v] of Object.entries(o)) {
            if (k === 'start' || k === 'end') continue;
            if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') visit(v);
        }
    };
    visit(node);
    return found;
}
