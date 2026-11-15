/**
 * Every resource and variable a Windmill flow uses (PLAN B2 refs.mts): the
 * `$res:<path>` / `$var:<path>` strings in static inputs and `flow_env`, and
 * the `getResource("…")` / `getVariable("…")` calls in script sources. Only the
 * PATH is collected; a value is never read, because there is none here to
 * read (bundle.mts drops a resource file's `value` on load).
 *
 * The scan of a script source is plain string work: find the call name,
 * then the quoted argument. No regular expression over uploaded text.
 */

import type { RefUse, WmFlow, WmInput, WmNode } from './ir.mts';
import { entries, isObject } from './util.mts';

const RES = '$res:';
const VAR = '$var:';
const CALLS: Array<{ name: string; kind: RefUse['kind'] }> = [
    { name: 'getResource(', kind: 'resource' },
    { name: 'get_resource(', kind: 'resource' },
    { name: 'getVariable(', kind: 'variable' },
    { name: 'get_variable(', kind: 'variable' },
];

/** A `$res:` / `$var:` string as a reference, or null. */
export function refOf(value: unknown): { kind: RefUse['kind']; path: string } | null {
    if (typeof value !== 'string') return null;
    if (value.startsWith(RES)) return { kind: 'resource', path: value.slice(RES.length) };
    if (value.startsWith(VAR)) return { kind: 'variable', path: value.slice(VAR.length) };
    return null;
}

/** Every reference anywhere inside a static value (nested objects and lists too). */
export function refsInValue(value: unknown, depth = 0): Array<{ kind: RefUse['kind']; path: string }> {
    if (depth > 32) return [];
    const own = refOf(value);
    if (own) return [own];
    if (Array.isArray(value)) return value.flatMap((v) => refsInValue(v, depth + 1));
    if (isObject(value)) return entries(value).flatMap(([, v]) => refsInValue(v, depth + 1));
    return [];
}

/** Paths named by a getResource / getVariable call with a literal argument. */
export function refsInSource(source: string): Array<{ kind: RefUse['kind']; path: string }> {
    const out: Array<{ kind: RefUse['kind']; path: string }> = [];
    for (const call of CALLS) {
        let at = source.indexOf(call.name);
        while (at !== -1) {
            const arg = quotedAt(source, at + call.name.length);
            if (arg) out.push({ kind: call.kind, path: arg });
            at = source.indexOf(call.name, at + call.name.length);
        }
    }
    for (const prefix of [RES, VAR]) {
        let at = source.indexOf(prefix);
        while (at !== -1) {
            const path = pathAt(source, at + prefix.length);
            if (path) out.push({ kind: prefix === RES ? 'resource' : 'variable', path });
            at = source.indexOf(prefix, at + prefix.length);
        }
    }
    return out;
}

function quotedAt(src: string, from: number): string | null {
    let i = from;
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;
    const q = src[i];
    if (q !== '"' && q !== '\'' && q !== '`') return null;
    const end = src.indexOf(q, i + 1);
    if (end === -1 || end - i > 300) return null;
    const value = src.slice(i + 1, end);
    return value.includes('${') ? null : value;
}

function pathAt(src: string, from: number): string | null {
    let end = from;
    while (end < src.length && isPathChar(src[end]) && end - from < 300) end += 1;
    return end > from ? src.slice(from, end) : null;
}

function isPathChar(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '/' || ch === '_' || ch === '-' || ch === '.';
}

function walkNodes(nodes: WmNode[], visit: (n: WmNode) => void): void {
    for (const n of nodes) {
        visit(n);
        if (n.children) walkNodes(n.children, visit);
        for (const b of n.branches ?? []) walkNodes(b.nodes, visit);
        if (n.defaultBranch) walkNodes(n.defaultBranch, visit);
    }
}

/** Every module of a flow, nested ones and the failure / preprocessor modules included. */
export function allNodes(flow: WmFlow): WmNode[] {
    const out: WmNode[] = [];
    walkNodes(flow.nodes, (n) => out.push(n));
    if (flow.failure) walkNodes([flow.failure], (n) => out.push(n));
    if (flow.preprocessor) walkNodes([flow.preprocessor], (n) => out.push(n));
    return out;
}

function inputRefs(input: WmInput): Array<{ kind: RefUse['kind']; path: string }> {
    if (input.type === 'static') return refsInValue(input.value);
    if (input.type === 'javascript') return refsInSource(input.expr);
    return [];
}

/** Every reference a flow makes, with where it was used. */
export function collectFlowRefs(flow: WmFlow): RefUse[] {
    const out: RefUse[] = [];
    for (const node of allNodes(flow)) {
        for (const [name, input] of Object.entries(node.inputs)) {
            for (const r of inputRefs(input)) out.push({ ...r, where: `${flow.path}#${node.wmId}.${name}` });
        }
        if (node.source) for (const r of refsInSource(node.source)) out.push({ ...r, where: `${flow.path}#${node.wmId}` });
    }
    for (const [name, value] of Object.entries(flow.options.flowEnv ?? {})) {
        const r = refOf(value);
        if (r) out.push({ ...r, where: `${flow.path}#flow_env.${name}` });
    }
    return out;
}
