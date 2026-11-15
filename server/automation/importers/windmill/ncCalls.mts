/**
 * The Nextcloud requests in a Windmill script (part of ocsMatcher.mts), read
 * from the acorn tree of the type-stripped script: `fetch`, `axios` and an
 * openapi-fetch `client.GET/POST/…`, each with its method, its path as
 * literal pieces and parameter slots, and its body. Nothing is run, and no
 * regular expression reads the source.
 */

import type { AnyNode } from './jsShapes.mts';
import { parseModule, stripTypes, walk } from './jsShapes.mts';

/** One piece of the request path: literal text, or a slot filled at run time. */
export type Piece = { text: string } | { slot: Slot };
export type Slot = { kind: 'param'; name: string } | { kind: 'user' } | { kind: 'base' };

export interface NcCall {
    method: string;
    pieces: Piece[];
    destination?: Piece[];
    /** The request body: a parameter name, or an object of parameter names / literals. */
    body?: BodyShape;
}

export type BodyShape = { param: string } | { object: Record<string, { param: string } | { literal: unknown }> } | { other: true };

const CONNECTION_PARAMS = new Set(['nextcloud', 'ncresource', 'nextcloudresource', 'resource', 'nc']);
const AXIOS_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch']);
const CLIENT_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** The Nextcloud calls of a script's main(), or null when the script has no plain main() or loops. */
export function readNcCalls(source: string): Array<NcCall | null> | null {
    const js = stripTypes(source);
    if ('error' in js) return null;
    const ast = parseModule(js.code);
    if (!ast) return null;
    const main = findMain(ast);
    if (!main || hasLoop(main.fn)) return null;
    const env: Env = { params: main.params, connection: connectionParam(main.params, main.fn), locals: baseLocals(main.fn) };
    return ncCalls(main.fn, env);
}

// ── main() ───────────────────────────────────────────────────────────────

export function findMain(ast: AnyNode): { fn: AnyNode; params: string[] } | null {
    for (const stmt of ast.body as AnyNode[]) {
        const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration as AnyNode | null : stmt;
        if (!decl) continue;
        if (decl.type === 'FunctionDeclaration' && (decl.id as AnyNode | null)?.name === 'main') {
            const params = paramNames(decl.params as AnyNode[]);
            return params ? { fn: decl, params } : null;
        }
    }
    return null;
}

function paramNames(params: AnyNode[]): string[] | null {
    const out: string[] = [];
    for (const p of params) {
        if (p.type === 'Identifier') out.push(p.name as string);
        else if (p.type === 'AssignmentPattern' && (p.left as AnyNode).type === 'Identifier') out.push((p.left as AnyNode).name as string);
        else return null;
    }
    return out;
}

function hasLoop(fn: AnyNode): boolean {
    let found = false;
    walk(fn, (n) => {
        if (n.type === 'ForStatement' || n.type === 'ForOfStatement' || n.type === 'ForInStatement' || n.type === 'WhileStatement' || n.type === 'DoWhileStatement') found = true;
    });
    return found;
}

interface Env {
    params: string[];
    connection: string | null;
    /** Local names assigned from the connection's base URL (`const base = nc.baseUrl.replace(…)`). */
    locals: Set<string>;
}

function connectionParam(params: string[], fn: AnyNode): string | null {
    for (const p of params) if (CONNECTION_PARAMS.has(p.toLowerCase())) return p;
    let found: string | null = null;
    walk(fn, (n) => {
        if (found || n.type !== 'MemberExpression' || n.computed) return;
        const obj = n.object as AnyNode;
        const prop = (n.property as AnyNode).name;
        if (obj.type === 'Identifier' && params.includes(obj.name as string) && (prop === 'baseUrl' || prop === 'token')) found = obj.name as string;
    });
    return found;
}

function baseLocals(fn: AnyNode): Set<string> {
    const out = new Set<string>();
    walk(fn, (n) => {
        if (n.type !== 'VariableDeclarator' || (n.id as AnyNode).type !== 'Identifier' || !n.init) return;
        let text = '';
        walk(n.init, (m) => { if (m.type === 'MemberExpression' && !m.computed && (m.property as AnyNode).name === 'baseUrl') text = 'base'; });
        if (text) out.add((n.id as AnyNode).name as string);
    });
    return out;
}

// ── Finding the calls ────────────────────────────────────────────────────

/** Every call that reaches Nextcloud; a call that does but cannot be read is null. */
function ncCalls(fn: AnyNode, env: Env): Array<NcCall | null> {
    const out: Array<NcCall | null> = [];
    walk(fn, (n) => {
        if (n.type !== 'CallExpression') return;
        const call = readCall(n, env);
        if (call !== undefined) out.push(call);
    });
    return out;
}

/** undefined: not a request call at all; null: a request this matcher cannot read. */
function readCall(n: AnyNode, env: Env): NcCall | null | undefined {
    const callee = n.callee as AnyNode;
    const args = n.arguments as AnyNode[];
    if (callee.type === 'Identifier' && callee.name === 'fetch') return readFetch(args, env);
    if (callee.type !== 'MemberExpression' || callee.computed) return undefined;
    const obj = callee.object as AnyNode;
    const method = (callee.property as AnyNode).name as string;
    if (obj.type === 'Identifier' && obj.name === 'axios') {
        if (method === 'request') return readAxiosConfig(args[0], env);
        if (AXIOS_METHODS.has(method)) return readAxiosShort(method.toUpperCase(), args, env);
        return null;
    }
    if (CLIENT_METHODS.has(method) && args[0]?.type === 'Literal') return readClient(method, args, env);
    return undefined;
}

/** A fetch to anywhere but Nextcloud is a request this matcher does not carry over: null. */
function readFetch(args: AnyNode[], env: Env): NcCall | null {
    const pieces = urlPieces(args[0], env);
    if (!pieces || !isNcPath(pieces)) return null;
    const opts = objectProps(args[1]);
    const method = literalString(opts.method) ?? 'GET';
    const call: NcCall = { method: method.toUpperCase(), pieces };
    const body = opts.body ? bodyOf(unwrapStringify(opts.body), env) : undefined;
    if (body) call.body = body;
    return call;
}

function readAxiosConfig(arg: AnyNode | undefined, env: Env): NcCall | null {
    const opts = objectProps(arg);
    const method = literalString(opts.method) ?? 'GET';
    const pieces = urlPieces(opts.url, env);
    if (!pieces || !isNcPath(pieces)) return null;
    const call: NcCall = { method: method.toUpperCase(), pieces };
    const headers = objectProps(opts.headers);
    if (headers.Destination) {
        const dest = urlPieces(headers.Destination, env);
        if (!dest) return null;
        call.destination = dest;
    }
    if (opts.data) call.body = bodyOf(opts.data, env);
    return call;
}

function readAxiosShort(method: string, args: AnyNode[], env: Env): NcCall | null {
    const pieces = urlPieces(args[0], env);
    if (!pieces || !isNcPath(pieces)) return null;
    const call: NcCall = { method, pieces };
    if ((method === 'PUT' || method === 'POST' || method === 'PATCH') && args[1]) call.body = bodyOf(args[1], env);
    return call;
}

function readClient(method: string, args: AnyNode[], env: Env): NcCall | null {
    const template = String((args[0]).value);
    const opts = objectProps(args[1]);
    const pathParams = objectProps(objectProps(opts.params).path);
    const pieces: Piece[] = [];
    let rest = template;
    while (rest.length) {
        const open = rest.indexOf('{');
        if (open === -1) { pieces.push({ text: rest }); break; }
        const close = rest.indexOf('}', open);
        if (close === -1) return null;
        if (open > 0) pieces.push({ text: rest.slice(0, open) });
        const slot = slotOf(pathParams[rest.slice(open + 1, close)], env);
        if (!slot) return null;
        pieces.push({ slot });
        rest = rest.slice(close + 1);
    }
    if (!isNcPath(pieces)) return null;
    const call: NcCall = { method, pieces };
    if (opts.body) call.body = bodyOf(opts.body, env);
    return call;
}

// ── Reading values ───────────────────────────────────────────────────────

function objectProps(node: AnyNode | undefined): Record<string, AnyNode> {
    const out: Record<string, AnyNode> = {};
    if (!node || node.type !== 'ObjectExpression') return out;
    for (const p of node.properties as AnyNode[]) {
        if (p.type !== 'Property' || p.computed) continue;
        const key = p.key as AnyNode;
        const name = key.type === 'Identifier' ? key.name as string : String(key.value);
        out[name] = p.value as AnyNode;
    }
    return out;
}

function literalString(node: AnyNode | undefined): string | null {
    return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

function unwrapStringify(node: AnyNode): AnyNode {
    if (node.type !== 'CallExpression') return node;
    const callee = node.callee as AnyNode;
    if (callee.type === 'MemberExpression' && (callee.object as AnyNode).name === 'JSON' && (callee.property as AnyNode).name === 'stringify') {
        return (node.arguments as AnyNode[])[0] ?? node;
    }
    return node;
}

function bodyOf(node: AnyNode, env: Env): BodyShape {
    if (node.type === 'Identifier' && env.params.includes(node.name as string)) return { param: node.name as string };
    if (node.type === 'Literal' && node.value === '') return { object: {} };
    if (node.type !== 'ObjectExpression') return { other: true };
    const object: Record<string, { param: string } | { literal: unknown }> = {};
    for (const [k, v] of Object.entries(objectProps(node))) {
        if (v.type === 'Identifier' && env.params.includes(v.name as string)) object[k] = { param: v.name as string };
        else if (v.type === 'Literal') object[k] = { literal: v.value };
        else return { other: true };
    }
    return { object };
}

function slotOf(node: AnyNode | undefined, env: Env): Slot | null {
    if (!node) return null;
    if (node.type === 'CallExpression' && (node.callee as AnyNode).type === 'Identifier' && (node.callee as AnyNode).name === 'encodeURIComponent') {
        return slotOf((node.arguments as AnyNode[])[0], env);
    }
    if (node.type === 'Identifier') return identifierSlot(node.name as string, env);
    if (node.type === 'MemberExpression' && !node.computed && (node.object as AnyNode).type === 'Identifier' && (node.object as AnyNode).name === env.connection) {
        return connectionSlot((node.property as AnyNode).name as string);
    }
    return null;
}

function identifierSlot(name: string, env: Env): Slot | null {
    if (env.locals.has(name)) return { kind: 'base' };
    return env.params.includes(name) && name !== env.connection ? { kind: 'param', name } : null;
}

function connectionSlot(prop: string): Slot | null {
    if (prop === 'userId' || prop === 'username') return { kind: 'user' };
    if (prop === 'baseUrl') return { kind: 'base' };
    return null;
}

function urlPieces(node: AnyNode | undefined, env: Env): Piece[] | null {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return [{ text: node.value }];
    if (node.type === 'TemplateLiteral') {
        const pieces: Piece[] = [];
        const quasis = node.quasis as Array<{ value: { cooked: string | null } }>;
        const exprs = node.expressions as AnyNode[];
        for (let i = 0; i < quasis.length; i += 1) {
            if (quasis[i].value.cooked) pieces.push({ text: quasis[i].value.cooked as string });
            if (exprs[i]) {
                const slot = slotOf(exprs[i], env);
                if (!slot) return null;
                pieces.push({ slot });
            }
        }
        return pieces;
    }
    return null;
}

/** The pieces after a leading base-URL slot, with the query string cut off. */
export function pathPieces(pieces: Piece[]): Piece[] {
    const out = pieces[0] && 'slot' in pieces[0] && pieces[0].slot.kind === 'base' ? pieces.slice(1) : [...pieces];
    const last = out[out.length - 1];
    if (last && 'text' in last && last.text.includes('?')) out[out.length - 1] = { text: last.text.slice(0, last.text.indexOf('?')) };
    return out;
}

function isNcPath(pieces: Piece[]): boolean {
    const first = pathPieces(pieces)[0];
    if (!first || !('text' in first)) return false;
    return first.text.startsWith('/ocs/') || first.text.startsWith('/remote.php/') || first.text.startsWith('/index.php/apps/');
}
