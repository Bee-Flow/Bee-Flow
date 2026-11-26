/**
 * The ownership map's format rules on small temp-dir fixtures (precedence, negation, the
 * two-owner error, colocated tests, cycles, the checks), and the committed map itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMap, globToRegExp, loadModuleMap, requiresCycle, summarize } from './module-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A throwaway repository (not a git work tree: the file list comes from a walk).
 * @param {object} map the module-map.json
 * @param {Record<string, string>} files repo-relative path -> content
 */
function fixture(map, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-map-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'module-map.json'), JSON.stringify(map));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return loadModuleMap(dir);
}

const PACKAGES = { server: { coreDir: 'server', moduleDir: 'server' } };
const mod = (server, extra = {}) => ({ name: 'x', requires: [], uses: [], server, ...extra });

test('globs: * stays in a segment, ** crosses them, {a,b} is a choice', () => {
    assert.ok(globToRegExp('a/*.js').test('a/b.js'));
    assert.ok(!globToRegExp('a/*.js').test('a/b/c.js'));
    assert.ok(globToRegExp('a/**').test('a/b/c.js'));
    assert.ok(globToRegExp('a/**/c.js').test('a/c.js'));
    assert.ok(globToRegExp('a/**/c.js').test('a/x/y/c.js'));
    assert.ok(globToRegExp('a/{b,c}*.js').test('a/cat.js'));
    assert.ok(!globToRegExp('a/{b,c}*.js').test('a/dog.js'));
    assert.ok(globToRegExp('a.b?.json').test('a.bc.json'));
    assert.ok(!globToRegExp('a.b').test('aXb'));
});

test('a core exception wins over a module glob; a file that matches nothing is core', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: { auto: mod(['automation/**']) },
        core: { server: ['automation/toolRegistry.js'] },
    }, { 'server/automation/run.js': '', 'server/automation/toolRegistry.js': '', 'server/chat.js': '' });
    assert.equal(map.ownerOf('server', 'automation/run.js'), 'auto');
    assert.equal(map.ownerOf('server', 'automation/toolRegistry.js'), null);
    assert.equal(map.ownerOf('server', 'chat.js'), null);
    assert.deepEqual(checkMap(map), []);
});

test('a !glob takes a file out of that module only', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: {
            auto: mod(['runner/**', '!runner/datatable*.js']),
            tables: mod(['runner/datatable*.js']),
        },
    }, { 'server/runner/run.js': '', 'server/runner/datatableResolve.js': '' });
    assert.equal(map.ownerOf('server', 'runner/run.js'), 'auto');
    assert.equal(map.ownerOf('server', 'runner/datatableResolve.js'), 'tables');
    assert.deepEqual(checkMap(map), []);
});

test('a file matched by two modules is an error', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: { a: mod(['shared/**']), b: mod(['shared/x.js']) },
    }, { 'server/shared/x.js': '' });
    assert.throws(() => map.ownerOf('server', 'shared/x.js'), /matches the globs of a and b/);
    assert.match(checkMap(map).join('\n'), /shared\/x\.js: owned by two modules \(a, b\)/);
});

test('a colocated test, testkit, golden, fixture or declaration follows its source', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: { learn: mod(['routes/verify.js', 'routes/feature/**']), auto: mod(['automation/**']) },
        core: { server: ['automation/toolRegistry.js'] },
    }, {
        'server/routes/verify.js': '',
        'server/routes/verify.test.js': '',
        'server/routes/verify.validation.test.js': '',
        'server/routes/verify.testkit.js': '',
        'server/routes/verify.characterisation.golden.json': '',
        'server/routes/verify.d.ts': '',
        'server/routes/verify.hang.fixture.js': '',
        'server/routes/feature/index.js': '',
        'server/routes/feature.integration.test.js': '',
        'server/automation/toolRegistry.js': '',
        'server/automation/toolRegistry.test.js': '',
        'server/lonely.test.js': '',
    });
    for (const p of ['verify.test.js', 'verify.validation.test.js', 'verify.testkit.js', 'verify.characterisation.golden.json', 'verify.d.ts', 'verify.hang.fixture.js']) {
        assert.equal(map.ownerOf('server', `routes/${p}`), 'learn', p);
    }
    assert.equal(map.ownerOf('server', 'routes/feature.integration.test.js'), 'learn', 'a test next to a directory with an index');
    assert.equal(map.ownerOf('server', 'automation/toolRegistry.test.js'), null, 'the core exception of the source carries over');
    assert.equal(map.ownerOf('server', 'lonely.test.js'), null);
});

test('a glob that names a colocated file itself wins over its source', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: { mcp: mod(['routes/mcpX.test.js']) },
    }, { 'server/routes/mcpX.js': '', 'server/routes/mcpX.test.js': '' });
    assert.equal(map.ownerOf('server', 'routes/mcpX.js'), null);
    assert.equal(map.ownerOf('server', 'routes/mcpX.test.js'), 'mcp');
});

test('non-code files are owned like code', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: { learn: mod(['learning/**', 'i18n/defaults/en/learn.js']) },
    }, { 'server/learning/pack.json': '{}', 'server/learning/logo.svg': '', 'server/i18n/defaults/en/learn.js': '' });
    assert.equal(map.ownerOf('server', 'learning/pack.json'), 'learn');
    assert.equal(map.ownerOf('server', 'learning/logo.svg'), 'learn');
    assert.equal(map.ownerOf('server', 'i18n/defaults/en/learn.js'), 'learn');
});

test('--check: unused globs, unknown ids, a file in the wrong module directory', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: { a: mod(['a/**', 'gone/**'], { uses: ['nope'] }), b: mod(['b/**']) },
        core: { server: ['never/**'] },
    }, { 'server/a/x.js': '', 'modules/a/server/b/y.js': '', 'modules/b/server/b/z.js': '' });
    const problems = checkMap(map).join('\n');
    assert.match(problems, /glob "gone\/\*\*" of a matches no file/);
    assert.match(problems, /glob "never\/\*\*" of core matches no file/);
    assert.match(problems, /a\.uses: unknown module "nope"/);
    assert.match(problems, /b\/y\.js: sits in modules\/a but the map says b/);
    assert.doesNotMatch(problems, /b\/z\.js/);
});

test('requires may not have a cycle; uses may', () => {
    assert.equal(requiresCycle({ a: { requires: ['b'] }, b: { requires: [] } }), null);
    assert.deepEqual(requiresCycle({ a: { requires: ['b'] }, b: { requires: ['c'] }, c: { requires: ['a'] } }), ['a', 'b', 'c', 'a']);
    const map = fixture({
        packages: PACKAGES,
        modules: { a: mod(['a.js'], { requires: ['b'] }), b: mod(['b.js'], { requires: ['a'] }) },
    }, { 'server/a.js': '', 'server/b.js': '' });
    assert.match(checkMap(map).join('\n'), /requires has a cycle: a -> b -> a/);
});

test('edges and the summary count core -> module, module -> core and module -> module, type-only left out', () => {
    const map = fixture({
        packages: PACKAGES,
        modules: { a: mod(['a/**'], { uses: ['b'] }), b: mod(['b/**']), c: mod(['c/**']) },
    }, {
        'server/index.js': "require('./a/x');\nimport type { T } from './b/y.js';\n",
        'server/util.js': '',
        'server/a/x.js': "require('../util');\nrequire('../b/y');\nfunction f() { return require('../c/z'); }\n",
        'server/a/x.test.js': "require('../c/z');\n",
        'server/b/y.js': '',
        'server/c/z.js': '/** @type {import("../a/x").T} */\n',
    });
    const edges = map.edges('server');
    assert.deepEqual(edges.map((e) => `${e.from}>${e.to}:${e.lazy ? 'lazy' : 'top'}`).sort(),
        ['a/x.js>b/y.js:top', 'a/x.js>c/z.js:lazy', 'a/x.js>util.js:top', 'index.js>a/x.js:top']);
    const rows = Object.fromEntries(summarize(map, 'server').map((r) => [r.id, r]));
    assert.equal(rows.a.coreIn, 1);
    assert.equal(rows.a.coreFiles, 1);
    assert.equal(rows.a.declared, 1);
    assert.equal(rows.a.undeclared, 1);
    assert.equal(rows.a.tests, 1);
    assert.equal(map.edges('server', { tests: true }).length, 5);
});

test('the committed map passes --check', () => {
    const out = execFileSync(process.execPath, [path.join(HERE, 'module-map.mjs'), '--check'], { encoding: 'utf8' });
    assert.match(out, /module-map: ok/);
});

test('core mode loads the map with require() and asks ownerOf synchronously', () => {
    const map = createRequire(import.meta.url)('./module-map.mjs').loadModuleMap();
    assert.equal(map.ownerOf('server', 'learning/visibility.js'), 'learning');
    assert.equal(map.ownerOf('server', 'chat.js'), null);
});

test('the pilot modules own exactly their files', () => {
    const map = loadModuleMap();
    const owner = (p) => map.ownerOf('server', p);
    assert.equal(owner('routes/verifyCertificate.js'), 'learning');
    assert.equal(owner('jobs/learningNudge.test.js'), 'learning');
    assert.equal(owner('services/outboundChatNotifier.js'), 'support');
    assert.equal(owner('stores/supportStore/threads.js'), 'support');
    assert.equal(owner('integrations/calendarTools.js'), 'int_google');
    assert.equal(owner('integrations/gmail/compose.js'), 'int_google');
    // prefixes that must not swallow a neighbour
    assert.equal(owner('integrations/msCalendarTools.js'), 'int_microsoft');
    assert.equal(owner('integrations/sheetDocumentTools.js'), null);
    assert.equal(owner('integrations/documentBuilderTools.js'), null);
    assert.equal(owner('auth/googleSessionHydration.js'), null);
    assert.equal(owner('core/providers/google.js'), null);
});

test('an i18n namespace and its Dutch twin have one owner', () => {
    const map = loadModuleMap();
    const files = new Map(map.files('server').map((f) => [f.treePath, f.owner]));
    for (const [p, o] of files) {
        const m = p.match(/^i18n\/defaults\/en\/(.+)\.js$/);
        const nl = m && `i18n/defaults/nl/${m[1]}.json`;
        if (nl && files.has(nl)) assert.equal(files.get(nl), o, `${p} and ${nl}`);
    }
});
