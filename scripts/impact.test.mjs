import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyse, main } from './impact.mjs';

let root;
const put = (rel, text = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
};

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-'));
    // server: a <- b <- c <- d <- e <- f (chain), tests next to a, b, f
    put('server/lib/a.js', 'module.exports = 1;\n');
    put('server/lib/a.test.js', "require('./a');\n");
    put('server/lib/a.extra.test.js', "// sibling with a suffix\nrequire('./a');\n");
    put('server/lib/b.js', "module.exports = require('./a');\n");
    put('server/lib/b.test.js', "require('./b');\n");
    put('server/lib/c.js', "module.exports = () => require('./b');\n"); // lazy require
    put('server/lib/d.js', "import c from './c.js';\nexport default c;\n");
    put('server/lib/e.js', "import d from './d.js';\nexport default d;\n");
    put('server/lib/f.js', "import e from './e.js';\nexport default e;\n");
    put('server/lib/f.test.js', "require('./f');\n");
    // text reader: names the basename of a changed file, not importing it
    put('server/lib/policy.json', '{}');
    put('server/lib/reader.test.js', "const fs = require('fs');\nfs.readFileSync(path.join(__dirname, 'policy.json'));\n");
    put('server/lib/unrelated.test.js', "const fs = require('fs');\nfs.readFileSync('other.json');\n");
    // excluded test that would otherwise be selected
    put('server/lib/infra.test.js', "require('./a');\n");
    put('server/scripts/test-exclusions.json', JSON.stringify({ exclusions: [{ file: 'lib/infra.test.js', bucket: 'needs-infra', reason: 'x' }] }));
    // shared mirror: server source -> agent-hub copy, test only imports the copy
    put('server/shared/expr/ev.js', 'module.exports = 1;\n');
    put('agent-hub/src/shared/expr/ev.js', 'module.exports = 1;\n');
    put('agent-hub/src/uses/ev.test.ts', "import ev from '../shared/expr/ev';\n");
    put('scripts/shared-mirror.manifest.json', JSON.stringify({ entries: [{ source: 'server/shared/expr', target: 'agent-hub/src/shared/expr', transform: 'none' }] }));
    // mobile lockstep test loads agent-hub source as text through webModule
    put('mobile/src/shared/testing/webModule.ts', 'export const x = 1;\n');
    put('agent-hub/src/utils/pure.ts', 'export const p = 1;\n');
    put('mobile/src/m/pure.lockstep.test.ts', "import { loadWebModule } from '../shared/testing/webModule';\nloadWebModule('utils/pure.ts');\n");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const files = (r, pkg) => (r.packages[pkg]?.tests ?? []).map((t) => t.file).sort();
const reasons = (r, pkg, file) => r.packages[pkg].tests.find((t) => t.file === file).reasons;

test('a test next to the file is selected, with its suffixed sibling', () => {
    const r = analyse(root, ['server/lib/a.js']);
    assert.ok(files(r, 'server').includes('server/lib/a.test.js'));
    assert.ok(files(r, 'server').includes('server/lib/a.extra.test.js'));
    assert.ok(reasons(r, 'server', 'server/lib/a.test.js').includes('sibling'));
});

test('a test that imports through a lazy require and import chain is selected, with the depth', () => {
    const r = analyse(root, ['server/lib/a.js']);
    assert.deepEqual(reasons(r, 'server', 'server/lib/b.test.js'), ['import depth 2']);
    assert.ok(files(r, 'server').includes('server/lib/f.test.js') === false, 'f is 5 hops away, beyond the default cap of 4');
    assert.ok(r.truncated.some((t) => t.file === 'server/lib/a.js'));
    const deep = analyse(root, ['server/lib/a.js'], { depth: 6 });
    assert.ok(files(deep, 'server').includes('server/lib/f.test.js'));
    assert.equal(deep.truncated.length, 0);
});

test('a test that reads the file as text is selected without importing it', () => {
    const r = analyse(root, ['server/lib/policy.json']);
    assert.deepEqual(files(r, 'server'), ['server/lib/reader.test.js']);
    assert.deepEqual(reasons(r, 'server', 'server/lib/reader.test.js'), ['text']);
});

test('a change to a mirror source selects the tests of its generated copy', () => {
    const r = analyse(root, ['server/shared/expr/ev.js']);
    assert.deepEqual(r.derived, ['agent-hub/src/shared/expr/ev.js']);
    assert.deepEqual(files(r, 'agent-hub'), ['agent-hub/src/uses/ev.test.ts']);
    assert.ok(reasons(r, 'agent-hub', 'agent-hub/src/uses/ev.test.ts')[0].startsWith('mirror:'));
    assert.ok(r.extra.some((e) => e.command === 'npm run -s lint:shared-mirror'));
});

test('a mobile lockstep test that loads agent-hub source is selected', () => {
    const r = analyse(root, ['agent-hub/src/utils/pure.ts']);
    assert.deepEqual(files(r, 'mobile'), ['mobile/src/m/pure.lockstep.test.ts']);
});

test('a server test in test-exclusions.json is never selected, and is reported', () => {
    const r = analyse(root, ['server/lib/a.js']);
    assert.ok(!files(r, 'server').includes('server/lib/infra.test.js'));
    assert.deepEqual(r.excluded, ['server/lib/infra.test.js']);
});

test('the commands are wrapped in heavy and run from the package directory', () => {
    const r = analyse(root, ['server/lib/a.js', 'agent-hub/src/utils/pure.ts']);
    assert.match(r.packages.server.command, /^cd server && \/home\/tom\/\.claude\/bin\/heavy node --test --require \.\/testUtils\/registerFeatures\.js lib\/a\.extra\.test\.js lib\/a\.test\.js lib\/b\.test\.js$/);
    assert.match(r.packages.mobile.command, /^cd mobile && \/home\/tom\/\.claude\/bin\/heavy \.\/node_modules\/\.bin\/jest -w 2 src\/m\/pure\.lockstep\.test\.ts$/);
    const hub = analyse(root, ['agent-hub/src/uses/ev.test.ts']);
    assert.equal(hub.packages['agent-hub'].command, 'cd agent-hub && /home/tom/.claude/bin/heavy npx vitest run --maxWorkers=2 src/uses/ev.test.ts');
});

test('main --json prints parseable output and nothing for an unknown flag', () => {
    const out = [];
    const log = console.log;
    console.log = (s) => out.push(s);
    try {
        assert.equal(main(['server/lib/policy.json', '--json'], root), 0);
        assert.equal(main(['server/lib/policy.json', '--bogus'], root), 2);
    } finally {
        console.log = log;
    }
    const parsed = JSON.parse(out[0]);
    assert.deepEqual(parsed.packages.server.tests.map((t) => t.file), ['server/lib/reader.test.js']);
});
