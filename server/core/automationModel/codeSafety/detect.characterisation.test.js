// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the code-step detector, through its
 * public entry analyzeCode: every finding (rule, severity, start and end
 * position, in order) and the capability facts, for snippets that reach every
 * branch of the node visitor: free and shadowed globals, names in key and
 * label positions, dynamic code in all its spellings, String.fromCharCode in
 * and out of loops, prototype and global-object tampering, ctx.http hosts
 * (literal, prefix, dynamic, in a loop, with and without allowed hosts),
 * integration tools and db, inputs reads, busy waits, literals (mining,
 * collection hosts, secrets, packed text), long lines, escaped identifiers and
 * the per-line dedupe. Each snippet runs with no options and with an allowed
 * tool and host.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/automationModel/codeSafety/detect.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { analyzeCode } = require('.');

const GOLDEN = path.join(__dirname, 'detect.characterisation.golden.json');

// Secret-shaped literals are built here so the secret scanner never meets one in this file.
const SK = ['sk', 'zyxwvutsrqponmlkjihg'].join('-');
const GH = ['ghp', 'Zyxwvutsrqponmlkjihg1234'].join('_');
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Deterministic high-entropy base64-shaped text (a small LCG, so the golden is stable). */
const B64 = (() => { let x = 7; let out = ''; for (let i = 0; i < 1400; i++) { x = (x * 1103515245 + 12345) % 2147483648; out += B64_CHARS[(x >> 16) % 64]; } return out; })();
const HEX_LONG = '0123456789abcdef'.repeat(140);
const HEX_SHORT = 'fedcba9876543210'.repeat(80);
const PLAIN_LONG = 'the quick brown fox '.repeat(80);

/** One probe per line, so the per-line dedupe never hides a finding. */
const lines = (/** @type {string[]} */ ...ls) => ls.join('\n');
/** A long literal broken over lines, so the line-length signal stays out of the way. */
const wrapped = (/** @type {string} */ s) => `return \`${(s.match(/.{1,80}/g) || []).join('\n')}\`;`;

/** @type {Record<string, string>} */
const CASES = {
    hostInternalName: lines('typeof __hostFetch;', 'typeof __bfRun;', 'typeof ivm;', 'Reference;', 'ExternalCopy;', 'typeof __other;'),
    nodeGlobals: lines('require;', 'module;', 'exports;', '__dirname;', '__filename;', 'process;'),
    processShadowed: 'function process(xs) { return xs; } return process(inputs.v);',
    requireShadowedByParam: 'const f = (require) => require(1); return f(inputs.a);',
    catchShadow: 'try { x(); } catch (process) { return process.message; }',
    patternShadow: lines('const { a: module, b = exports } = inputs;', 'return module + b;'),
    classShadow: 'class Atomics {} return new Atomics();',
    lowLevel: lines('WebAssembly;', 'SharedArrayBuffer;', 'Atomics.add(1);', 'eval;'),
    evalShadowed: 'let eval2 = 1; function g(eval) { return eval; } return g(eval2);',
    keyPositions: lines('const o = { process: 1, require() {} };', '({ [module]: 2 });', 'o.exports;'),
    shorthandKey: 'const o = { process }; return o;',
    classMembers: lines('class K { require() { return 1; } process = 2; }', 'class L { static [module] = 3; }'),
    labels: 'process: for (const x of inputs.xs) { if (x) break process; else continue process; } return 1;',
    importAndMeta: lines('await import("node:fs");', 'function F() { return new.target; }'),
    withStmt: 'with (inputs) { return value; }',
    functionCall: lines('Function("return 1");', 'new Function("a", "return a");'),
    functionShadowed: 'const Function = (x) => x; return Function("a");',
    timers: lines('setTimeout("go()", 10);', 'setInterval("tick()", 5);', 'const code = "go()";', 'setTimeout(code, 1);',
        'setTimeout(() => ctx.log("x"), 10);', 'setInterval(inputs.fn, 5);', 'setTimeout();', 'other("x");', 'setTimeout(5);'),
    constructorCalls: lines('x.constructor("a");', 'y.constructor();', 'new z.constructor(1);', 'const k = "constructor";',
        'a[k](1);', 'b["con" + "structor"](2);', 'c[`constructor`](3);', 'd[inputs.k](4);', 'e["constructorX"](5);'),
    constructorChain: lines('[].constructor.constructor;', '({})["constructor"]["constructor"];', 'a.b.constructor;', 'Function.prototype.call;', 'Function.other;'),
    fromCharCode: lines(
        `String.fromCharCode(${Array.from({ length: 20 }, (_, i) => 65 + i).join(',')});`,
        `String.fromCharCode(${Array.from({ length: 19 }, (_, i) => 65 + i).join(',')});`,
        'for (const c of inputs.codes) {', '  String.fromCharCode(c);', '}',
        'inputs.codes.map((c) => String.fromCharCode(c));',
        'inputs.codes["reduce"]((s, c) => s + String.fromCharCode(c), "");',
        'while (inputs.n--) { const f = function () {', '  return String["fromCharCode"](1);', '}; }',
        'inputs.codes.slice(0, 2).concat([String.fromCharCode(65)]);',
        'inputs.codes.map(String.fromCharCode(66));',
        'Strung.fromCharCode(1);'),
    tampering: lines('Object.setPrototypeOf(a, null);', 'Reflect.setPrototypeOf(b, null);', 'Reflect.__defineGetter__("x", f);', 'Math.setPrototypeOf(c);',
        'Object.keys(globalThis);', 'Reflect.ownKeys(self);', 'Object.entries(global);', 'Object.getOwnPropertyDescriptors(window);',
        'Object.getOwnPropertyNames(globalThis);', 'Object.values(globalThis);', 'Object.keys();', 'Object.keys(inputs);',
        'Object.defineProperty(Array.prototype, "x", {});', 'Object.defineProperties(String["prototype"], {});', 'Object.keys(Foo.prototype);', 'Object.keys(Array.other);'),
    globalEnumerationShadowed: 'const window = {}; return Object.keys(window);',
    http: lines('await ctx.http("https://api.example.com/v1/rates");', 'ctx.http(`https://api.other.org/items/${inputs.id}`);',
        'const base = "https://svc.example.net/";', 'ctx.http(base + "a/" + inputs.id);', 'const u = "https://whole.example.com/x";', 'ctx.http(u);',
        'ctx.http(inputs.url);', 'ctx.http();', 'ctx.http(inputs.scheme + "://x.example.com");', 'ctx["http"]("https://comp.example.com/");', 'other.http("https://no.example.com/");'),
    httpInLoops: lines('for (let i = 0; i < 3; i++) {', '  await ctx.http("https://api.example.com/p/" + i);', '}',
        'inputs.ids.forEach((id) => ctx.http(`https://api.example.com/${id}`));', 'inputs.ids.slice((id) => ctx.http(inputs.u));'),
    httpCustomCtx: lines('async function main(inp, c) {', '  c.http(inp.url);', '  ctx.http("https://not.ctx.example/");', '}'),
    integrations: lines('await ctx.integrations.gmail_send({});', 'await ctx.integrations["slack_post"]({});', 'ctx.integrations[inputs.t]();',
        'ctx.db.query("x");', 'ctx["db"].insert(1);', 'ctx.integrations[inputs.k](ctx.db.query(1));', 'other.integrations.x();', 'ctx.other.x();'),
    internalProps: lines('r.derefInto();', 'r["applySync"]();', 'r.getSync;', 'r.setSync;', 'r.transferList;', 'r.cachedData;', 'r.applyIgnored;', 'r.applySyncPromise;',
        'o.__hostX;', 'o["__hostX"];', 'o["__bfY"];', 'o["ivm"];', 'o.ivm;'),
    globalComputed: lines('globalThis["eval"];', 'self["Function"];', 'global["myconstructorX"];', 'window[inputs.k];', 'globalThis["plain"];', 'globalThis.eval;', 'globalThis["ev" + "al"];'),
    globalComputedShadowed: 'const self = {}; return self[inputs.k];',
    protoAndErrors: lines('o.__proto__.x = 1;', 'o["__proto__"];', 'Error.prepareStackTrace = null;', 'Error.captureStackTrace(o);', 'Error.stackTraceLimit;',
        'function f() {', '  arguments.callee;', '  arguments.caller;', '  arguments.length;', '}'),
    inputsReads: 'return inputs.a + inputs["b"] + inputs[inputs.c] + other.d;',
    inputsDestructured: 'const { a, b: c, ["d"]: e, ...rest } = inputs; const { f } = other; const [g] = inputs; let h; return [a, c, e, rest, f, g, h];',
    inputsCustomName: 'function main(data, ctx) { const { x } = data; return data.y + inputs.z; }',
    assignments: lines('Object.prototype.polluted = 1;', 'Array.prototype = [];', 'String.prototype.a.b = 2;', 'Foo.prototype.x = 3;',
        'Math.max = () => 0;', 'JSON.parse = (x) => x;', 'Promise.all = null;', 'globalThis.x = 1;', 'self.y = 2;',
        'let a = 1;', 'a = 2;', 'o.y = 3;', 'o["z"] = 4;', 'Object["prototype"]["k"] = 5;'),
    assignBuiltinShadowed: 'const Math = {}; Math.max = 1; const Array = function () {}; Array.prototype.x = 1; return Math;',
    forIn: lines('for (const k in globalThis) ctx.log(k);', 'for (const k in inputs) ctx.log(k);'),
    forInShadowedGlobal: 'const global = {}; for (const k in global) ctx.log(k); return 1;',
    loops: lines('while (true) { inputs.n++; }', 'for (;;) { inputs.m++; }', 'do { inputs.o++; } while (true);',
        'while (true) { if (inputs.done) break; }', 'for (;;) { return 1; }', 'do { throw new Error("x"); } while (true);',
        'while (true) { await ctx.http("https://api.example.com/"); }', 'while (true) { const f = () => { return 1; }; f(); }',
        'while (true) { function* g() { yield 1; } }',
        'const end = Date.now() + 100;', 'while (Date.now() < end) {}', 'while (performance.now() < end) { inputs.x++; }', 'for (; new Date() < end;) {}',
        'while (Date.now() < end) { if (inputs.x) break; }', 'while (1) { inputs.x++; }', 'while (inputs.go) {}', 'while (other.now() < end) {}'),
    literals: lines('"stratum+tcp://pool.example:3333";', '"https://pool.minexmr.com/x";', '"https://webhook.site/abc";',
        '`https://discord.com/api/webhooks/1/${inputs.t}`;', `"${SK}";`, `\`token ${GH}\`;`, '[1, true, null, /re/g, 10n];', '"plain words";',
        '"pool.minexmr.com and webhook.site";', `"pool.minexmr.com ${SK}";`),
    packedBase64: wrapped(B64),
    packedHexLong: wrapped(HEX_LONG),
    hexNotLongEnough: wrapped(HEX_SHORT),
    plainLongText: wrapped(PLAIN_LONG),
    hugeLiteral: wrapped('ab '.repeat(3500)),
    longLine: `const x = [${Array.from({ length: 260 }, (_, i) => i).join(', ')}];\nreturn x;`,
    longLiteralLine: `return "${B64}";`,
    escapedIdentifier: lines('const \\u0061b = 1;', 'return \\u0061b + ev\\u0061l;'),
    sameRuleSameLine: lines('return [require, require, process];', 'return [module];'),
    multiLine: 'const a = 1;\n\nreturn eval(\n  "x"\n) + process\n  .env;',
    benignMix: 'const rows = inputs.rows || []; const out = rows.filter((r) => r.ok).map((r) => ({ ...r, n: r.n * 2 })); return out;',
    syntaxError: 'return {;',
};

const OPTION_SETS = /** @type {const} */ ({
    none: undefined,
    allowed: { allowedTools: ['gmail_send'], allowedHosts: ['api.example.com'] },
});

/** @param {string} code @param {any} opts */
function summarise(code, opts) {
    const a = analyzeCode(code, opts);
    return {
        ok: a.ok,
        syntaxError: a.syntaxError,
        findings: a.findings.map((/** @type {any} */ f) => `${f.ruleId}|${f.severity}|${f.approver || ''}|${f.line}:${f.column}-${f.endLine}:${f.endColumn}|${f.messageKey}|${f.fixKey || ''}`),
        capabilities: a.capabilities,
    };
}

test('code-step detector: every case matches the golden result', () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [name, code] of Object.entries(CASES)) {
        for (const [set, opts] of Object.entries(OPTION_SETS)) actual[`${name}/${set}`] = summarise(code, opts);
    }
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(actual)) assert.deepEqual(actual[name], golden[name], name);
});
