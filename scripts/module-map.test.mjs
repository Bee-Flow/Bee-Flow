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

const WEB = {
    server: { coreDir: 'server', moduleDir: 'server' },
    'agent-hub': { coreDir: 'agent-hub', moduleDir: 'frontend', imports: { style: 'vite', alias: { '@/': 'src/' } } },
};
const webMod = (web, extra = {}) => ({ name: 'x', requires: [], uses: [], server: [], 'agent-hub': web, ...extra });

test('the web client: tree paths under src/, colocated tests and split-off parts follow their component', () => {
    const map = fixture({
        packages: WEB,
        modules: { help: webMod(['src/components/help/**']), side: webMod(['src/shell/Panel.helpers.ts']) },
        core: { 'agent-hub': ['src/components/help/keep.ts'] },
    }, {
        'agent-hub/src/components/help/Desk.tsx': '',
        'agent-hub/src/components/help/keep.ts': '',
        'agent-hub/src/shell/Panel.tsx': '',
        'agent-hub/src/shell/Panel.test.tsx': '',
        'agent-hub/src/shell/Panel.threads.test.jsx': '',
        'agent-hub/src/shell/Panel.types.ts': '',
        'agent-hub/src/shell/Panel.helpers.ts': '',
        'agent-hub/src/shell/Panel.module.css': '',
        'agent-hub/src/shell/Panel.testkit.tsx': '',
        'agent-hub/src/shell/lonely.types.ts': '',
        'agent-hub/vite.config.js': '',
    });
    const owner = (p) => map.ownerOf('agent-hub', p);
    assert.equal(owner('src/components/help/Desk.tsx'), 'help');
    assert.equal(owner('src/components/help/keep.ts'), null, 'a core exception wins in the web client too');
    for (const p of ['Panel.test.tsx', 'Panel.threads.test.jsx', 'Panel.types.ts', 'Panel.module.css', 'Panel.testkit.tsx']) assert.equal(owner(`src/shell/${p}`), null, p);
    assert.equal(owner('src/shell/Panel.helpers.ts'), 'side', 'a glob that names the split-off part wins over its component');
    assert.equal(owner('src/shell/lonely.types.ts'), null);
    assert.equal(owner('vite.config.js'), null);
    assert.equal(map.ownerOf('server', 'src/components/help/Desk.tsx'), null, 'the packages do not share globs');
    const rows = Object.fromEntries(summarize(map, 'agent-hub').map((r) => [r.id, r]));
    assert.equal(rows.core.tests, 3, 'tests and testkits count as tests, split-off parts do not');
    assert.equal(rows.core.files, 9);
    assert.deepEqual(checkMap(map), []);
});

test('--check covers the web client: a glob that matches nothing, a file two modules claim', () => {
    const map = fixture({
        packages: WEB,
        modules: { a: webMod(['src/a/**', 'src/gone/**']), b: webMod(['src/a/shared.ts']) },
    }, { 'agent-hub/src/a/x.tsx': '', 'agent-hub/src/a/shared.ts': '' });
    const problems = checkMap(map).join('\n');
    assert.match(problems, /agent-hub: glob "src\/gone\/\*\*" of a matches no file/);
    assert.match(problems, /agent-hub\/src\/a\/shared\.ts: owned by two modules \(a, b\)/);
});

test('web client edges: the alias, static and lazy core -> module edges counted apart, types left out', () => {
    const map = fixture({
        packages: WEB,
        modules: { help: webMod(['src/help/**']), learn: webMod(['src/learn/**'], { uses: ['help'] }) },
    }, {
        'agent-hub/src/App.tsx': [
            "import Desk from '@/help/Desk';",
            "import type { T } from './learn/types';",
            "const Course = lazy(() => import('./learn/Course'));",
            'export default () => <Desk />;',
        ].join('\n'),
        'agent-hub/src/util.ts': '',
        'agent-hub/src/help/Desk.tsx': "import { u } from '../util';\n",
        'agent-hub/src/help/Desk.test.tsx': "import Course from '@/learn/Course';\n",
        'agent-hub/src/learn/Course.tsx': "import Desk from '@/help/Desk';\nimport { u } from '@/util';\n",
        'agent-hub/src/learn/types.ts': '',
    });
    assert.deepEqual(map.edges('agent-hub').map((e) => `${e.from}>${e.to}:${e.lazy ? 'lazy' : 'top'}`).sort(), [
        'src/App.tsx>src/help/Desk.tsx:top',
        'src/App.tsx>src/learn/Course.tsx:lazy',
        'src/help/Desk.tsx>src/util.ts:top',
        'src/learn/Course.tsx>src/help/Desk.tsx:top',
        'src/learn/Course.tsx>src/util.ts:top',
    ]);
    const rows = Object.fromEntries(summarize(map, 'agent-hub').map((r) => [r.id, r]));
    assert.deepEqual([rows.help.coreIn, rows.help.coreInLazy], [1, 0]);
    assert.deepEqual([rows.learn.coreIn, rows.learn.coreInLazy], [1, 1]);
    assert.equal(rows.learn.declared, 1);
    assert.equal(rows.help.coreFiles, 1);
    assert.equal(rows.help.tests, 1);
});

test('the CLI takes --pkg agent-hub for --owner and --list', () => {
    const run = (...args) => execFileSync(process.execPath, [path.join(HERE, 'module-map.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(run('--owner', 'agent-hub/src/components/support/SupportDrawer.tsx', '--pkg', 'agent-hub').trim(), 'support');
    assert.equal(run('--owner', 'src/AgentHub.tsx', '--pkg', 'agent-hub').trim(), 'core');
    const listed = run('--list', 'learning', '--pkg', 'agent-hub').trim().split('\n');
    assert.ok(listed.includes('src/pages/settings/LearningCenterSection.tsx'));
    assert.ok(listed.every((p) => p.startsWith('src/')));
    assert.throws(() => execFileSync(process.execPath, [path.join(HERE, 'module-map.mjs'), '--summary', '--pkg', 'nope'], { stdio: 'pipe' }));
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

test('the web client pilots: learning, support and int_google own exactly their screens', () => {
    const map = loadModuleMap();
    const owner = (p) => map.ownerOf('agent-hub', p);
    assert.equal(owner('src/pages/settings/LearningCenterSection.tsx'), 'learning');
    assert.equal(owner('src/pages/settings/learning/CourseView.video.test.tsx'), 'learning');
    assert.equal(owner('src/components/onboarding/player/LessonPlayer.tsx'), 'learning');
    assert.equal(owner('src/components/onboarding/generated/lessons.js'), 'learning');
    assert.equal(owner('src/hooks/useTrainingGates.ts'), 'learning');
    assert.equal(owner('src/i18n/en/learn.generated.mjs'), 'learning');
    assert.equal(owner('src/components/support/SupportInboxPanel.tsx'), 'support');
    assert.equal(owner('src/components/admin/Studio/SupportStudio/SupportSettings.tsx'), 'support');
    assert.equal(owner('src/pages/settings/HelpSupportSection.test.tsx'), 'support');
    assert.equal(owner('src/i18n/en/support.generated.mjs'), 'support');
    assert.equal(owner('src/components/chat/GmailPicker.tsx'), 'int_google');
    assert.equal(owner('src/components/chat/MessageItem/KeepDraftCard.tsx'), 'int_google');
    assert.equal(owner('src/lib/googleOAuthPopup.test.ts'), 'int_google');
    // the tour engine, e-mail verification and the shared draft cards stay core
    for (const p of ['src/components/onboarding/OnboardingTour.tsx', 'src/components/onboarding/tourSteps.ts', 'src/components/onboarding/EmailVerificationScreen.tsx',
        'src/api/lessons.types.ts', 'src/components/chat/MessageItem/EmailDraftCard.tsx', 'src/components/chat/MessageItem/DraftCardShell.tsx',
        'src/pages/meeting-notes/hooks/useGoogleMeetConnected.ts', 'src/marketing/sections/CustomerSupport.tsx']) {
        assert.notEqual(owner(p), 'learning', p);
        assert.notEqual(owner(p), 'support', p);
        assert.notEqual(owner(p), 'int_google', p);
    }
});

test('a generated i18n chunk of the web client has the owner of its server namespace', () => {
    const map = loadModuleMap();
    const server = new Map(map.files('server').map((f) => [f.treePath, f.owner]));
    for (const f of map.files('agent-hub')) {
        const m = f.treePath.match(/^src\/i18n\/en\/(.+)\.generated\.mjs$/);
        const ns = m && `i18n/defaults/en/${m[1]}.js`;
        if (ns && server.has(ns)) assert.equal(f.owner, server.get(ns), f.treePath);
    }
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
