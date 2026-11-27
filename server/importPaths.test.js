// @typecheck
/**
 * Guard: every relative require()/import inside the server package resolves to
 * a file that actually exists.
 *
 * This exists because a wrong relative path is invisible until the exact branch
 * that lazily requires it runs — and both places it happened here wrapped the
 * require in a try/catch, so the feature silently did nothing instead of
 * crashing:
 *
 *   • core/agentRuntime/attachmentProcessor.js required './documentParser'
 *     (the module is one level up). Every docx/xlsx/pptx/csv upload hit the
 *     catch and was dropped from the model's context.
 *   • routes/ai/directChat.js required '../../terminal/tools', a module that
 *     never existed — dead tool injection (BFSF-127).
 *
 * Comments are stripped before scanning, so the many `require('./foo')` samples
 * inside docblocks don't register. Specifiers that are deliberately fake
 * (stub-loader fixtures, host-injected module ids) are listed in ALLOWED.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { walkServerTree, requestPlaces } = require('./testUtils/serverTree');

const SRC_RE = /\.(js|jsx|mjs|cjs)$/;
const SKIP_DIR = new Set(['node_modules', 'migrations', 'assets', 'prompts']);

// Specifiers that are intentionally unresolvable: fixtures for the require
// stubbing helpers, and paths generated INTO customer projects (not ours).
const ALLOWED = new Set([
    './x', './y', '../x', '../../x', './someStore', './studioAppStore',
    './App.jsx', './styles.css', './components/Header.jsx', './assets/logo.png',
    './automation/builderTools/triggerProviders', './automation/builderTools/triggerCatalog',
    '../../db',
]);

// Per-file exemptions, each with the reason. Deliberately NOT in ALLOWED: a
// specifier like '../db' is a plausible typo almost everywhere else in the
// tree, and blanket-allowing it would blunt exactly the check this file
// exists for. Same shape as the EXEMPT maps in migrateDb.registration.test.js
// and boot/bootMigrations.test.js — an entry here is a claim a reviewer can
// check, not an escape hatch.
/** @param {string[]} specs requests written in the source of a test's temp-dir fixture tree */
function fixtureTree(specs) {
    return new Map(specs.map((spec) => [spec, 'fixture source: a file of the temp-dir tree the resolver tests build']));
}

const ALLOWED_PER_FILE = new Map([
    ['stores/lib/_ddl.js', new Map([
        // Documented dual-resolve (see the _dbFacade docblock): the hermetic
        // store tests intercept the literal '../db' request for files under
        // stores/ with a DB-free stub, and the try/catch falls through to the
        // real '../../db' everywhere else. The specifier must stay a literal
        // string — computing it would hide the intent from this very check.
        ['../db', 'lazy dual-resolve: test-hook target, falls back to ../../db'],
    ])],
    ['stores/lib/storeInit.js', new Map([
        // Same documented dual-resolve as _ddl.js above, and for the same
        // reason: the store doubles intercept the literal '../db' request.
        ['../db', 'lazy dual-resolve: test-hook target, falls back to ../../db'],
    ])],
    ['shared/webpage/previewDocument.pin.test.mjs', new Map([
        // Fixture text, not an import of this package: the pin test feeds a
        // React entry with a broken import into the preview bundler to pin
        // the build-error document. The string must keep the import syntax.
        ['./missing.jsx', 'bundler fixture: a deliberately unresolvable React entry'],
    ])],
    ['auth/accessRegistry.sweep.test.js', new Map([
        // The synthetic fixtures that prove the route sweep bites: in-memory
        // app source fed to the parser, never loaded as modules.
        ['./auth', 'synthetic fixture source for the sweep proof'],
        ['./routes/dingen', 'synthetic fixture source for the sweep proof'],
        ['./routes/beveiligd', 'synthetic fixture source for the sweep proof'],
        ['./routes/leeg', 'synthetic fixture source for the sweep proof'],
        // Second fixture app: the router split over a folder (the routes/webpages|datatables|playbooks
        // idiom). Also pure source text — the paths were written from routes/gesplitst/, not from auth/.
        ['./routes/gesplitst', 'synthetic fixture source: split-router proof'],
        ['../../auth/permissions', 'synthetic fixture source: split-router proof'],
        ['./vroeg', 'synthetic fixture source: split-router proof'],
        ['./laat', 'synthetic fixture source: split-router proof'],
        ['./opties', 'synthetic fixture source: split-router proof'],
    ])],
    ['routes/webpages/draftDocument.test.js', new Map([
        // Fixture source for the bundler's error path: an in-memory src/main.jsx
        // that imports a file which does not exist, on purpose.
        ['./Missing.jsx', 'fixture source: the missing import the build error names'],
    ])],
    ['core/webpages/bfElements.drift.test.js', new Map([
        // A needle searched in the SOURCE of the two bridge files under
        // services/ (beside the engine, so './bfBridgeNotices' is right THERE),
        // proving each loads the shared engine instead of carrying a copy.
        ['./bfBridgeNotices', 'source needle into services/*: the bridges share one engine'],
    ])],
    // The resolver tests write a throwaway multi-root tree to a temp directory and run
    // probes there: these are the sources of that tree's files, resolved inside it
    // (and two that must not resolve anywhere), never from server/.
    ['moduleRoots.test.js', fixtureTree([
        '../feat/a', '../lib/shared', '../other/b', '../lib/own', '../lib/fromCore', '../other/fromM2',
        '../thing', '../data/conf.json', '../feat/e.mts', '../feat/pkgs', '../use/pkg', '../use/pkg.mjs',
        '../lib/esmCore.mts', '../nowhere/x', '../nowhere/x.mjs', '../../sibling/outside', '../feat/leaves',
    ])],
    ['modules/roots/rootSet.test.js', fixtureTree(['../n', '../n8', '../feat/a', '../feat/e.mjs'])],
    // The same for the dictionary loaders and the test runner: probe sources that run in
    // a temp tree with a second root, where these paths are right.
    ['i18n/defaults/en.discovery.test.js', fixtureTree(['./i18n/defaults/en/index.js'])],
    ['i18n/defaults/nl/index.test.js', fixtureTree(['./i18n/defaults/nl/index.js'])],
    ['scripts/run-tests.test.mjs', fixtureTree(['./alpha/helper.cjs'])],
    ['testUtils/serverTree.test.js', fixtureTree(['../lib/moved', '../feat/b'])],
]);

function stripComments(src) {
    // Order matters: block comments first, then line comments. Strings that
    // contain "//" survive because we only strip from an unquoted position —
    // approximated by requiring the // to not be preceded by a ':' (URLs).
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The source files of every root of the tree (server/ and each modules/<id>/server). */
function listFiles() {
    return walkServerTree({
        skipDirs: [...SKIP_DIR],
        controlFiles: true,
        filter: (_rel, e) => !e.name.startsWith('.') && (e.isDirectory() || SRC_RE.test(e.name)),
    });
}

const EXTS = ['', '.js', '.jsx', '.mjs', '.cjs', '.json', '.node'];
/** Does the request resolve in some root (the resolver looks up a tree path in every root)? */
function resolves(fromTreePath, spec) {
    return requestPlaces(fromTreePath, spec).some(resolvesAt);
}

/** @param {string} base the absolute place a request points at, before extensions */
function resolvesAt(base) {
    for (const ext of EXTS) {
        try { if (fs.statSync(base + ext).isFile()) return true; } catch (_) { }
    }
    for (const ext of EXTS.slice(1)) {
        try { if (fs.statSync(path.join(base, 'index' + ext)).isFile()) return true; } catch (_) { }
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
        if (pkg.main || pkg.exports) return true;
    } catch (_) { }
    return false;
}

const PATTERNS = [
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    // The require-stubbing helpers take the module id as a bare string, so a
    // file move leaves them dangling exactly like a real require would — and
    // they fail at load time, not at assertion time.
    /\b(?:mock|stub|stubRequire|mockRequire)\(\s*['"]([^'"]+)['"]/g,
];

// NOT scanned: installResolveStub's { '<module id>': stub } map. Those keys are
// matched against the require string as written INSIDE THE MODULE UNDER TEST
// (see testUtils/stubRequire.js), not relative to the test file — so resolving
// them from the test's own directory reports nonsense. They still go stale when
// a module moves, and they fail quietly when they do (the stub never matches,
// the real module loads, and the test dies somewhere unrelated), but catching
// that needs a different check than this one.

test('every relative require/import in the server tree (every root) resolves to a real file', () => {
    const files = listFiles();
    assert.ok(files.length > 500, `expected to scan the server tree, saw ${files.length} files`);

    const broken = [];
    const usedExemptions = new Set();
    for (const { treePath: rel, abs } of files) {
        const perFile = ALLOWED_PER_FILE.get(rel);
        const src = stripComments(fs.readFileSync(abs, 'utf8'));
        const seen = new Set();
        for (const re of PATTERNS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(src)) !== null) {
                const spec = m[1];
                if (!spec.startsWith('.')) continue;
                if (ALLOWED.has(spec)) continue;
                if (perFile && perFile.has(spec)) { usedExemptions.add(`${rel}  ->  ${spec}`); continue; }
                if (spec.includes('?')) continue;           // ?raw / ?url loader suffixes
                if (seen.has(spec)) continue;
                seen.add(spec);
                if (!resolves(rel, spec)) {
                    broken.push(`${rel}  ->  ${spec}`);
                }
            }
        }
    }

    assert.deepStrictEqual(broken, [], `unresolvable relative imports:\n  ${broken.join('\n  ')}`);

    // A per-file exemption that no longer matches anything is a claim about
    // code that has since moved on — it must go, or the next real breakage
    // hides behind it.
    const dead = [];
    for (const [file, specs] of ALLOWED_PER_FILE) {
        for (const spec of specs.keys()) {
            if (!usedExemptions.has(`${file}  ->  ${spec}`)) dead.push(`${file}  ->  ${spec}`);
        }
    }
    assert.deepStrictEqual(dead, [],
        `these per-file exemptions match nothing any more — remove them:\n  ${dead.join('\n  ')}`);
});
