/**
 * The code shim (codeShim.mts): a plain Windmill TypeScript script becomes a
 * code step that really runs in the isolated-vm sandbox (research A-12: the
 * isolate has no console and no fetch, the shim brings both through ctx), and
 * a script with packages, wmill or a private host is refused.
 *
 * Run: cd server && node --test automation/importers/windmill/codeShim.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { shimScript } = require('./codeShim.mts');
const sandbox = require('../../codeSandbox');

const PURE = `type Row = { title: string };

function upper(s: string): string { return s.toUpperCase(); }

export async function main(rows: Row[], prefix: string = "#") {
  console.log("rows", rows.length);
  return rows.map((r, i) => \`\${prefix}\${i + 1} \${upper(r.title)}\`);
}
`;

test('a pure script is shimmed into async function main(inputs, ctx)', () => {
    const r = shimScript(PURE, 'Number the rows');
    assert.strictEqual(r.ok, true, r.reason);
    assert.deepStrictEqual(r.params, ['rows', 'prefix']);
    assert.deepStrictEqual(r.allowedHosts, []);
    assert.ok(r.code.includes('async function main(inputs, ctx)'));
    assert.ok(r.code.includes('return __wm_main(inputs.rows, inputs.prefix);'));
    assert.ok(!r.code.includes('export '));
    assert.ok(r.code.includes('@param {*} inputs.rows'));
});

test('the shimmed script runs in the code-step sandbox, with console on ctx.log', { skip: !sandbox.isAvailable() && 'isolated-vm is not installed' }, async () => {
    const { code } = shimScript(PURE, 'Number the rows');
    const out = await sandbox.runCode({ code, inputs: { rows: [{ title: 'a' }, { title: 'b' }] } });
    assert.deepStrictEqual(out.result, ['#1 A', '#2 B']);
    assert.deepStrictEqual(out.logs, ['rows 2']);
});

test('a fetch to a fixed public https host is allowed and listed', () => {
    const r = shimScript('export async function main(q: string) { const r = await fetch("https://api.example.com/v1/q", { method: "POST", body: q }); return r.status; }', 'Ask');
    assert.strictEqual(r.ok, true, r.reason);
    assert.deepStrictEqual(r.allowedHosts, ['api.example.com']);
    assert.ok(r.code.includes('ctx.http(url'));
});

test('packages, wmill, Node globals, private hosts and dynamic URLs are refused', () => {
    const cases = {
        imports: 'import axios from "axios";\nexport async function main() { return axios.get("https://x.example.com"); }',
        wmill: 'export async function main() { return wmill.getVariable("f/x"); }',
        process: 'export async function main() { return process.env.HOME; }',
        buffer: 'export async function main(s: string) { return Buffer.from(s).toString("base64"); }',
        privateHost: 'export async function main() { return fetch("https://10.0.0.5/x"); }',
        dynamic: 'export async function main(u: string) { return fetch(u); }',
        noMain: 'export async function run() { return 1; }',
    };
    for (const [name, src] of Object.entries(cases)) {
        const r = shimScript(src, name);
        assert.strictEqual(r.ok, false, name);
        assert.ok(r.reason, name);
    }
});
