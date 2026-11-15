/**
 * The importer's safety promises (PLAN B7, B8): no secret value travels, names
 * that leave the export and inflated archives are refused before anything is
 * read, a YAML alias bomb is refused, and converting never runs a line of
 * the imported code or expressions.
 *
 * Fake secrets are built at run time, so this file holds no secret-shaped text.
 *
 * Run: cd server && node --test automation/importers/windmill/security.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const JSZip = require('jszip');

const { toIntermediate, toBeeFlow, PathRefused, BundleError } = require('./index.mts');
const { inputOf } = require('./goldenFixtures.mjs');
const { scrubSource, SECRET_REMOVED } = require('./scrub.mts');

const asText = (value) => JSON.stringify(value, (k, v) => (v instanceof Map ? [...v.entries()] : v));

test('a resource file\'s token is never kept, and never reaches the result', async () => {
    const bundle = await toIntermediate(await inputOf('native-trigger-bundle'));
    const marker = 'q'.repeat(32);
    assert.ok(!asText(bundle).includes(marker), 'not in the intermediate model');
    const result = toBeeFlow(bundle);
    assert.ok(!asText(result).includes(marker), 'not in the definitions or reports');
    assert.deepStrictEqual(bundle.resources, [{ path: 'f/ops/nextcloud', resourceType: 'nextcloud' }]);
    const hook = result.flows.find((f) => f.flowPath === 'f/ops/ticket_hook');
    assert.deepStrictEqual(hook.report.connections.map((c) => c.path), ['f/ops/nextcloud']);
});

test('a hard-coded key in a script is removed from the note, the checklist and the report', async () => {
    const skKey = `sk-${'Ab3d'.repeat(6)}`;
    const named = 'x'.repeat(24);
    const random = crypto.randomBytes(32).toString('base64url');
    const source = `def main():\n    api_key = "${named}"\n    other = "${skKey}"\n    blob = "${random}"\n    return 1\n`;
    const flow = { summary: 'Keys', value: { modules: [{ id: 'k', summary: 'Keys', value: { type: 'rawscript', language: 'python3', content: source, input_transforms: { token: { type: 'static', value: random } } } }] } };
    const result = toBeeFlow(await toIntermediate({ kind: 'object', value: flow }));
    const text = asText(result);
    for (const secret of [skKey, named, random]) assert.ok(!text.includes(secret), 'secret removed');
    assert.ok(text.includes(SECRET_REMOVED));
    assert.ok(result.flows[0].report.warnings.some((w) => w.code === 'secret_removed'));
});

test('scrubSource keeps ordinary text', () => {
    const src = 'const url = "https://cloud.example.org/remote.php/dav/files";\nconst name = "Monthly report";\nconst password = "";\n';
    assert.deepStrictEqual(scrubSource(src), { text: src, removed: 0 });
});

test('a file name that leaves the export is refused', async () => {
    await assert.rejects(toIntermediate({ kind: 'files', files: { '../outside/flow.yaml': 'summary: x' } }), PathRefused);
    await assert.rejects(toIntermediate({ kind: 'files', files: { '/etc/flow.yaml': 'summary: x' } }), PathRefused);
    const zip = new JSZip();
    zip.file('f/a__flow/flow.yaml', 'summary: A\nvalue:\n  modules: []\n');
    zip.file('f/../../escape.yaml', 'x: 1');
    await assert.rejects(toIntermediate({ kind: 'zip', data: await zip.generateAsync({ type: 'nodebuffer' }) }), PathRefused);
});

test('an inline script reference that climbs out of the flow folder is not read', async () => {
    const files = {
        'f/a__flow/flow.yaml': "summary: A\nvalue:\n  modules:\n    - id: s\n      value:\n        type: rawscript\n        language: bun\n        content: '!inline ../../../secret.ts'\n        input_transforms: {}\n",
        'secret.ts': 'export function main() { return "x"; }',
    };
    const bundle = await toIntermediate({ kind: 'files', files });
    assert.strictEqual(bundle.flows[0].nodes[0].source, '');
    assert.ok(bundle.readWarnings.some((w) => w.includes('../../../secret.ts')));
});

test('an archive that unpacks too far is refused on its declarations', async () => {
    const zip = new JSZip();
    zip.file('f/a__flow/flow.yaml', 'summary: A\nvalue:\n  modules: []\n');
    zip.file('f/a__flow/big.ts', Buffer.alloc(4 * 1024 * 1024));
    const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.ok(data.length < 64 * 1024, 'the archive itself is small');
    await assert.rejects(toIntermediate({ kind: 'zip', data }, { maxTotalBytes: 1024 * 1024 }), BundleError);
    await assert.rejects(toIntermediate({ kind: 'zip', data }, { maxEntries: 1 }), BundleError);
});

test('a YAML alias bomb is refused', async () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (const [name, prev] of [['b', 'a'], ['c', 'b'], ['d', 'c'], ['e', 'd']]) lines.push(`${name}: &${name} [${Array(10).fill(`*${prev}`).join(', ')}]`);
    await assert.rejects(toIntermediate({ kind: 'text', text: lines.join('\n') }), (e) => e instanceof BundleError && e.message.includes('alias'));
    const bundle = await toIntermediate({ kind: 'files', files: { 'f/a.schedule.yaml': lines.join('\n') } });
    assert.deepStrictEqual(bundle.schedules, []);
    assert.ok(bundle.readWarnings.some((w) => w.includes('alias')), bundle.readWarnings.join(' '));
});

test('nothing in the importer runs imported code', async () => {
    delete globalThis.__wmProbe;
    const probe = 'globalThis.__wmProbe = (globalThis.__wmProbe || 0) + 1';
    const flow = {
        summary: 'Probe',
        value: {
            skip_expr: probe,
            modules: [
                { id: 'a', value: { type: 'rawscript', language: 'bun', content: `${probe};\nexport async function main() { ${probe}; return 1; }`, input_transforms: { x: { type: 'javascript', expr: probe } } } },
                { id: 'b', skip_if: { expr: probe }, value: { type: 'rawscript', language: 'python3', content: 'def main():\n    return 1\n', input_transforms: {} } },
                { id: 'c', value: { type: 'forloopflow', iterator: { type: 'javascript', expr: `[${probe}]` }, modules: [] } },
            ],
        },
    };
    const result = toBeeFlow(await toIntermediate({ kind: 'object', value: flow }));
    assert.strictEqual(globalThis.__wmProbe, undefined);
    assert.ok(result.flows[0].report.aiChecklist.length > 0);
});
