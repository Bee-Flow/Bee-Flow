/**
 * Shared pieces of the Windmill expression translator (mapExpr.mts): the
 * types, the refusal errors, and the readers of member chains. Split out so
 * the emitters (exprEmit.mts) and the call translators (exprCalls.mts) share
 * them without importing each other.
 */

import type * as acorn from 'acorn';
import { isIdentifier } from './util.mts';

export type Node = acorn.Node & Record<string, unknown>;

export type Seg = { kind: 'name'; v: string } | { kind: 'index'; v: number } | { kind: 'key'; v: string };

/** What a root name resolves to: a path, a dropped input, a ready DSL fragment, or a refusal. */
export type Resolved =
    | { path: string; confidence?: 'high' | 'medium' }
    | { dsl: string }
    | { drop: string }
    | { unsupported: string };

export interface ExprScope {
    flowInput(segs: Seg[]): Resolved;
    result(wmId: string, segs: Seg[]): Resolved;
    /** `resume`, `resumes`, `approvers` (after an approval). */
    resume?(name: string, segs: Seg[]): Resolved;
    /** `result` inside stop_after_if. */
    current?(segs: Seg[]): Resolved;
    /** `previous_result` (older flows). */
    previous?(segs: Seg[]): Resolved;
    /** `error` inside the failure module. */
    error?(segs: Seg[]): Resolved;
}

export type Binding =
    | { kind: 'literal'; value: unknown }
    | { kind: 'ref'; path: string }
    | { kind: 'template'; value: string }
    | { kind: 'expr'; value: string };

export class Unsupported extends Error {}
export class Dropped extends Error {}

export const FORBIDDEN_NAMES = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__']);
export const MAX_SOURCE = 4000;

export interface Out {
    dsl: string;
    /** Set when the node is a plain path (a ref binding, a {{ }} placeholder). */
    path?: string;
    /** A string literal's value. */
    text?: string;
    /** The node is a call or a path: segments may follow it without parentheses. */
    atomic: boolean;
}

export interface Ctx {
    scope: ExprScope;
    src: string;
    it: string | null;
    medium: boolean;
    /** The emitter, handed to the call translators (exprCalls.mts) so they need not import it back. */
    emit: (node: Node, ctx: Ctx) => Out;
}

/** Translate one Windmill input transform into a Bee Flow binding. */
// ── Paths ────────────────────────────────────────────────────────────────

/** A member chain down to an identifier: the root name and its literal segments; null when dynamic. */
export function chainOf(node: Node): { root: string; segs: Seg[] } | null {
    const segs: Seg[] = [];
    let cur: Node = node;
    for (;;) {
        if (cur.type === 'ChainExpression' || cur.type === 'ParenthesizedExpression') { cur = cur.expression as Node; continue; }
        if (cur.type === 'Identifier') return { root: cur.name as string, segs: segs.reverse() };
        if (cur.type !== 'MemberExpression') return null;
        const seg = segOf(cur);
        if (!seg) return null;
        segs.push(seg);
        cur = cur.object as Node;
    }
}

export function segOf(member: Node): Seg | null {
    const prop = member.property as Node;
    if (!member.computed) {
        const name = prop.name as string;
        if (FORBIDDEN_NAMES.has(name)) throw new Unsupported(`"${name}" is never translated.`);
        return { kind: 'name', v: name };
    }
    if (prop.type === 'Literal' && typeof prop.value === 'number' && Number.isInteger(prop.value)) return { kind: 'index', v: prop.value };
    if (prop.type === 'Literal' && typeof prop.value === 'string') {
        if (FORBIDDEN_NAMES.has(prop.value)) throw new Unsupported(`"${prop.value}" is never translated.`);
        return { kind: 'key', v: prop.value };
    }
    if (prop.type === 'UnaryExpression' && prop.operator === '-' && (prop.argument as Node).type === 'Literal') {
        const n = (prop.argument as Node).value;
        if (typeof n === 'number' && Number.isInteger(n)) return { kind: 'index', v: -n };
    }
    return null;
}

/** Segments written onto a path in the Bee Flow path grammar. */
export function segText(segs: Seg[]): string {
    return segs.map((s) => {
        if (s.kind === 'index') return `[${s.v}]`;
        if (isIdentifier(s.v)) return `.${s.v}`;
        return `[${JSON.stringify(s.v)}]`;
    }).join('');
}

export function snippet(node: Node, ctx: Ctx): string {
    const s = ctx.src.slice(node.start, node.end);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

export function wrap(out: Out): string {
    return out.atomic ? out.dsl : `(${out.dsl})`;
}

