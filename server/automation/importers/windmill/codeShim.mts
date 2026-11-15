/**
 * A plain inline Windmill TypeScript/JavaScript script as a Bee Flow `code`
 * step (PLAN B3 codeShim.mts, research 06 §C.6).
 *
 * Fits only a script with no `import`, no `wmill.*`, no Node/Bun/Deno global,
 * no dynamic code and no request except a `fetch` to a literal public https
 * host. The shim then:
 *   1. strips the types (esbuild `transform`; Node's stripTypeScriptTypes is experimental),
 *   2. drops `export`, renames `main` to `__wm_main`,
 *   3. wraps it in `async function main(inputs, ctx)` that calls `__wm_main`
 *      with the inputs in the order of the original signature,
 *   4. puts `console` on `ctx.log` and `fetch` on `ctx.http` (the isolate has
 *      neither, research A-12), and lists the fetched hosts in `allowedHosts`,
 *   5. runs the product's own code-safety analysis on the result; a blocking
 *      finding means the script is not a fit after all.
 *
 * The code is never executed here. It runs later, if at all, as a code step in
 * the isolated-vm sandbox with its usual limits (1 s CPU, 5 s wall, 64 MB by
 * default): a script that needs longer fails visibly in the dry run.
 */

import { createRequire } from 'node:module';
import type { AnyNode } from './jsShapes.mts';
import { parseModule, stripTypes, walk } from './jsShapes.mts';
import { findMain } from './ncCalls.mts';

const nodeRequire = createRequire(import.meta.url);
const { analyzeCode } = nodeRequire('../../../core/automationModel/codeSafety') as {
    analyzeCode: (code: string, opts: { allowedHosts: string[] }) => { ok: boolean; findings: Array<{ severity: string; rule?: string; id?: string; message?: string }> };
};
const { isPrivateHostname } = nodeRequire('../../../utils/ssrfGuard') as { isPrivateHostname: (host: string) => boolean };

const FORBIDDEN = new Set([
    'wmill', 'require', 'process', 'Buffer', 'Deno', 'Bun', 'globalThis', 'global', 'window', 'eval', 'Function',
    'crypto', 'setTimeout', 'setInterval', 'XMLHttpRequest', 'WebSocket', 'btoa', 'atob', 'module', 'exports',
    '__dirname', '__filename', 'importScripts', 'axios',
]);

export type ShimResult = { ok: true; code: string; params: string[]; allowedHosts: string[] } | { ok: false; reason: string };

export function shimScript(source: string, summary: string | undefined): ShimResult {
    const js = stripTypes(source);
    if ('error' in js) return { ok: false, reason: `The script does not compile (${js.error}).` };
    const ast = parseModule(js.code);
    if (!ast) return { ok: false, reason: 'The script does not parse as a module.' };
    const problem = firstProblem(ast);
    if (problem) return { ok: false, reason: problem };
    const main = findMain(ast);
    if (!main) return { ok: false, reason: 'The script has no exported main() with plain parameters.' };
    const hosts = fetchHosts(ast);
    if ('problem' in hosts) return { ok: false, reason: hosts.problem };
    const code = wrap(js.code, ast, main.params, summary);
    if (!code) return { ok: false, reason: 'main() is referenced in a way the shim cannot rename.' };
    const analysis = analyzeCode(code, { allowedHosts: hosts.hosts });
    if (!analysis.ok) return { ok: false, reason: 'The shimmed script does not pass the code check.' };
    const blocking = analysis.findings.filter((f) => f.severity === 'block');
    if (blocking.length) return { ok: false, reason: `The code check refuses it: ${blocking.map((f) => f.message ?? f.rule ?? f.id).join('; ')}` };
    return { ok: true, code, params: main.params, allowedHosts: hosts.hosts };
}

function firstProblem(ast: AnyNode): string | null {
    let problem: string | null = null;
    walk(ast, (n, parent) => {
        if (problem) return;
        if (n.type === 'ImportDeclaration' || n.type === 'ImportExpression') problem = 'The script imports a package.';
        else if (n.type === 'ExportDefaultDeclaration' || n.type === 'ExportAllDeclaration') problem = 'The script has a default export.';
        else if (n.type === 'Identifier' && FORBIDDEN.has(n.name as string) && !isPropertyName(n, parent)) problem = `The script uses "${n.name}", which a code step does not have.`;
        else if (n.type === 'NewExpression' && (n.callee as AnyNode).type === 'Identifier' && (n.callee as AnyNode).name === 'Function') problem = 'The script builds code at run time.';
    });
    return problem;
}

/** `x.process` or `{ process: 1 }` names a property, not the global. */
function isPropertyName(n: AnyNode, parent: AnyNode | null): boolean {
    if (!parent) return false;
    if (parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return true;
    if (parent.type === 'Property' && parent.key === n && !parent.computed) return true;
    return false;
}

function fetchHosts(ast: AnyNode): { hosts: string[] } | { problem: string } {
    const hosts = new Set<string>();
    let problem: string | null = null;
    walk(ast, (n) => {
        if (problem || n.type !== 'CallExpression') return;
        const callee = n.callee as AnyNode;
        if (callee.type !== 'Identifier' || callee.name !== 'fetch') return;
        const host = literalHost((n.arguments as AnyNode[])[0]);
        if (!host) problem = 'The script fetches an address that is not a fixed https:// URL.';
        else if (isPrivateHostname(host)) problem = `The script calls ${host}, a private address a code step cannot reach.`;
        else hosts.add(host);
    });
    return problem ? { problem } : { hosts: [...hosts].sort() };
}

/** The fixed text a URL argument starts with. */
function literalPrefix(arg: AnyNode): string | null {
    if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
    if (arg.type === 'TemplateLiteral') return ((arg.quasis as Array<{ value: { cooked: string | null } }>)[0]?.value.cooked) ?? null;
    return null;
}

function hostEnd(rest: string): number {
    let end = 0;
    while (end < rest.length && !'/?#:'.includes(rest[end])) end += 1;
    return end;
}

function literalHost(arg: AnyNode | undefined): string | null {
    const text = arg ? literalPrefix(arg) : null;
    if (!arg || !text || !text.startsWith('https://')) return null;
    const rest = text.slice('https://'.length);
    const end = hostEnd(rest);
    const host = rest.slice(0, end).toLowerCase();
    if (!host) return null;
    // A template whose fixed part stops inside the host name could finish it at run time.
    if (end === rest.length && arg.type !== 'Literal') return null;
    return host;
}

const CONSOLE = 'const console = { log: (...a) => ctx.log(...a), info: (...a) => ctx.log(...a), warn: (...a) => ctx.log(...a), error: (...a) => ctx.log(...a), debug: (...a) => ctx.log(...a) };';
const FETCH = [
    'const fetch = async (url, opts) => {',
    '    const r = await ctx.http(url, opts || {});',
    '    if (r && r.error) throw new Error(r.error);',
    '    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: r.headers, text: async () => r.body, json: async () => JSON.parse(r.body) };',
    '};',
];

function wrap(js: string, ast: AnyNode, params: string[], summary: string | undefined): string | null {
    const edits: Array<{ start: number; end: number; text: string }> = [];
    let mainId: AnyNode | null = null;
    for (const stmt of ast.body as AnyNode[]) {
        const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration as AnyNode | null : stmt;
        // esbuild writes `export { main }` after the function: that statement goes as a whole.
        if (stmt.type === 'ExportNamedDeclaration') edits.push({ start: stmt.start, end: decl ? decl.start : stmt.end, text: '' });
        if (decl && decl.type === 'FunctionDeclaration' && (decl.id as AnyNode | null)?.name === 'main') mainId = decl.id as AnyNode;
    }
    if (!mainId) return null;
    let refs = 0;
    walk(ast, (n, parent) => { if (n.type === 'Identifier' && n.name === 'main' && parent?.type !== 'ExportSpecifier') refs += 1; });
    if (refs !== 1) return null;
    edits.push({ start: mainId.start, end: mainId.end, text: '__wm_main' });
    let body = js;
    for (const e of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, e.start) + e.text + body.slice(e.end);
    const doc = jsDoc(summary, params);
    const prelude = [...(usesName(ast, 'console') ? [CONSOLE] : []), ...(usesName(ast, 'fetch') ? FETCH : [])];
    const call = `return __wm_main(${params.map((p) => `inputs.${p}`).join(', ')});`;
    const indented = body.trim().split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
    const head = prelude.map((l) => `    ${l}\n`).join('');
    return `${doc}\nasync function main(inputs, ctx) {\n${head}${indented}\n    ${call}\n}\n`;
}

function usesName(ast: AnyNode, name: string): boolean {
    let found = false;
    walk(ast, (n, parent) => { if (n.type === 'Identifier' && n.name === name && !isPropertyName(n, parent)) found = true; });
    return found;
}

function jsDoc(summary: string | undefined, params: string[]): string {
    const first = (summary || 'Converted from a Windmill script.').split('*/').join('* /');
    const lines = ['/**', ` * ${first}`, ...params.map((p) => ` * @param {*} inputs.${p} - ${p}`), ' */'];
    return lines.join('\n');
}
