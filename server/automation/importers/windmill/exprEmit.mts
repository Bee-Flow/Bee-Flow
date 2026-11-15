/**
 * The syntax tree of a Windmill expression written out as a Bee Flow
 * expression (part of mapExpr.mts): literals, operators, the ternary, list
 * literals and member paths. Calls are in exprCalls.mts.
 */

import type { Ctx, Node, Out, Resolved, Seg } from './exprTypes.mts';
import { Dropped, Unsupported, chainOf, segOf, segText, snippet, wrap } from './exprTypes.mts';
import { emitCall } from './exprCalls.mts';

// ── Emitting DSL ─────────────────────────────────────────────────────────

type Emitter = (node: Node, ctx: Ctx) => Out;

const EMITTERS = new Map<string, Emitter>([
    ['Literal', emitLiteral],
    ['Identifier', emitPathLike],
    ['MemberExpression', emitPathLike],
    ['ChainExpression', (n, ctx) => emit(n.expression as Node, ctx)],
    ['ParenthesizedExpression', (n, ctx) => emit(n.expression as Node, ctx)],
    ['TemplateLiteral', emitTemplateLiteral],
    ['UnaryExpression', emitUnary],
    ['BinaryExpression', emitBinary],
    ['LogicalExpression', emitBinary],
    ['ConditionalExpression', emitConditional],
    ['ArrayExpression', emitArray],
    ['ObjectExpression', emitObject],
    ['CallExpression', emitCall],
]);

export function emit(node: Node, ctx: Ctx): Out {
    const fn = EMITTERS.get(node.type);
    if (!fn) throw new Unsupported(`"${snippet(node, ctx)}" has no counterpart in a Bee Flow expression.`);
    return fn(node, ctx);
}

function emitLiteral(node: Node): Out {
    if ((node as Record<string, unknown>).regex) throw new Unsupported('Regular expressions in an expression are not translated.');
    const v = node.value;
    if (typeof v === 'string') return { dsl: JSON.stringify(v), text: v, atomic: true };
    if (typeof v === 'number' && Number.isFinite(v)) return { dsl: String(v), atomic: true };
    if (typeof v === 'boolean' || v === null) return { dsl: String(v), atomic: true };
    throw new Unsupported('This literal has no counterpart in a Bee Flow expression.');
}

function emitTemplateLiteral(node: Node, ctx: Ctx): Out {
    const quasis = node.quasis as Array<{ value: { cooked: string | null } }>;
    const exprs = node.expressions as Node[];
    const parts: string[] = [];
    quasis.forEach((q, i) => {
        if (q.value.cooked) parts.push(JSON.stringify(q.value.cooked));
        if (exprs[i]) parts.push(`toStr(${emit(exprs[i], ctx).dsl})`);
    });
    if (parts.length === 0) return { dsl: '""', text: '', atomic: true };
    return { dsl: parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`, atomic: true };
}

const UNARY = new Set(['!', '-', '+']);

function emitUnary(node: Node, ctx: Ctx): Out {
    const op = node.operator as string;
    if (!UNARY.has(op)) throw new Unsupported(`The operator "${op}" is not translated.`);
    const arg = emit(node.argument as Node, ctx);
    return { dsl: `${op}${wrap(arg)}`, atomic: false };
}

const BINARY = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '&&', '||', '??']);

function emitBinary(node: Node, ctx: Ctx): Out {
    const op = node.operator as string;
    if (op === '**') return { dsl: `${wrap(emit(node.left as Node, ctx))} ^ ${wrap(emit(node.right as Node, ctx))}`, atomic: false };
    if (!BINARY.has(op)) throw new Unsupported(`The operator "${op}" is not translated.`);
    const left = emit(node.left as Node, ctx);
    const right = emit(node.right as Node, ctx);
    return { dsl: `${wrap(left)} ${op} ${wrap(right)}`, atomic: false };
}

function emitConditional(node: Node, ctx: Ctx): Out {
    const t = emit(node.test as Node, ctx);
    const a = emit(node.consequent as Node, ctx);
    const b = emit(node.alternate as Node, ctx);
    return { dsl: `${wrap(t)} ? ${wrap(a)} : ${wrap(b)}`, atomic: false };
}

function emitArray(node: Node, ctx: Ctx): Out {
    const items = (node.elements as Array<Node | null>).map((el) => {
        if (!el || el.type === 'SpreadElement') throw new Unsupported('A spread or a hole in a list is not translated.');
        return emit(el, ctx).dsl;
    });
    return { dsl: `[${items.join(', ')}]`, atomic: true };
}

function emitObject(): Out {
    throw new Unsupported('An object is built with an "Edit data" step in Bee Flow; an expression cannot write one.');
}

// ── Paths ────────────────────────────────────────────────────────────────

function emitPathLike(node: Node, ctx: Ctx): Out {
    const chain = chainOf(node);
    if (chain) return emitChain(chain.root, chain.segs, ctx);
    return emitDynamicMember(node, ctx);
}

function emitChain(root: string, segs: Seg[], ctx: Ctx): Out {
    if (segs.length && segs[segs.length - 1].kind === 'name' && segs[segs.length - 1].v === 'length') {
        const inner = emitChain(root, segs.slice(0, -1), ctx);
        return { dsl: `len(${inner.dsl})`, atomic: true };
    }
    if (root === 'undefined' && segs.length === 0) return { dsl: 'null', atomic: true };
    if (ctx.it !== null && root === ctx.it) {
        const path = `it${segText(segs)}`;
        return { dsl: path, atomic: true };
    }
    const resolved = resolveRoot(root, segs, ctx);
    if ('drop' in resolved) throw new Dropped(resolved.drop);
    if ('unsupported' in resolved) throw new Unsupported(resolved.unsupported);
    if ('dsl' in resolved) return { dsl: resolved.dsl, atomic: false };
    if (resolved.confidence === 'medium') ctx.medium = true;
    if (ctx.it !== null) return { dsl: resolved.path, atomic: true };
    return { dsl: resolved.path, path: resolved.path, atomic: true };
}

function resolveRoot(root: string, segs: Seg[], ctx: Ctx): Resolved {
    const s = ctx.scope;
    switch (root) {
        case 'flow_input': return s.flowInput(segs);
        case 'results': {
            const first = segs[0];
            if (!first || first.kind === 'index') return { unsupported: '"results" without a step id is not translated.' };
            return s.result(first.v, segs.slice(1));
        }
        case 'resume': case 'resumes': case 'approvers':
            return s.resume ? s.resume(root, segs) : { unsupported: `"${root}" only exists after an approval step.` };
        case 'result': return s.current ? s.current(segs) : { unsupported: '"result" is only known inside stop_after_if.' };
        case 'previous_result': return s.previous ? s.previous(segs) : { unsupported: '"previous_result" has no step before it here.' };
        case 'error': return s.error ? s.error(segs) : { unsupported: '"error" is only known in the failure handler.' };
        default: return { unsupported: `The name "${root}" is not known to the converter.` };
    }
}

/** `x.split("/")[0]`, `f(x).name`: segments after something that is not a plain chain. */
function emitDynamicMember(node: Node, ctx: Ctx): Out {
    if (node.type !== 'MemberExpression') throw new Unsupported(`"${snippet(node, ctx)}" is not translated.`);
    const lastIdx = lastItemIdiom(node, ctx);
    if (lastIdx) return lastIdx;
    const seg = segOf(node);
    if (!seg) throw new Unsupported(`The computed key in "${snippet(node, ctx)}" is not translated.`);
    const obj = emit(node.object as Node, ctx);
    if (seg.kind === 'name' && seg.v === 'length') return { dsl: `len(${obj.dsl})`, atomic: true };
    return { dsl: `${wrap(obj)}${segText([seg])}`, atomic: true };
}

/** `s.split(d)[s.split(d).length - 1]` is `last(split(s, d))`. */
function lastItemIdiom(node: Node, ctx: Ctx): Out | null {
    if (!node.computed) return null;
    const prop = node.property as Node;
    if (prop.type !== 'BinaryExpression' || prop.operator !== '-') return null;
    const right = prop.right as Node;
    const left = prop.left as Node;
    if (right.type !== 'Literal' || right.value !== 1 || left.type !== 'MemberExpression') return null;
    const lenProp = left.property as Node;
    if (left.computed || lenProp.name !== 'length') return null;
    const objText = ctx.src.slice((node.object as Node).start, (node.object as Node).end).split(' ').join('');
    const lenText = ctx.src.slice((left.object as Node).start, (left.object as Node).end).split(' ').join('');
    if (objText !== lenText) return null;
    return { dsl: `last(${emit(node.object as Node, ctx).dsl})`, atomic: true };
}

