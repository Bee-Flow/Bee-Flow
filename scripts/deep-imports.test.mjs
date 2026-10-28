/**
 * The codemod rewrites text that compiles, so the cases that matter are the ones
 * where a rewrite would change meaning: a path that is not a module specifier, a
 * path that leaves src/, a file the alias must not reach, and the spelling of
 * what stays (quotes, extension, trailing slash).
 *
 * Sandbox style is scripts/count-ratchet.test.mjs's: a throwaway repo under
 * os.tmpdir() with the real script copied in. The TypeScript parser comes from
 * the real root node_modules, linked into the sandbox.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { aliasFor, applyRewrites, deepSpecifiers, excludedFiles } from './deep-imports.mjs';

// The parser is the TypeScript compiler API (root typescript-api, else agent-hub's). The
// workflow-policy job runs these tests without npm ci, so the parser tests skip there.
let hasTs = false;
for (const [from, name] of [['../package.json', 'typescript-api'], ['../agent-hub/package.json', 'typescript']]) {
    try { createRequire(new URL(from, import.meta.url))(name); hasTs = true; break; } catch { /* not installed */ }
}
const tsTest = hasTs ? test : test.skip;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The file as the codemod would leave it. */
const rewrite = (text, rel) => applyRewrites(text, deepSpecifiers(text, rel));

test('aliasFor maps a deep specifier to the path from src and keeps the spelling after it', () => {
    assert.strictEqual(aliasFor('../../../utils/helpers', 'components/a/b/c.ts'), '@/utils/helpers');
    assert.strictEqual(aliasFor('../../../utils/helpers.js', 'components/a/b/c.ts'), '@/utils/helpers.js');
    assert.strictEqual(aliasFor('../../../hooks/useX/', 'components/a/b/c.ts'), '@/hooks/useX/');
    // A detour through a sibling folder normalises to the real target.
    assert.strictEqual(aliasFor('../../../components/a/../c/D', 'components/a/b/e.ts'), '@/components/c/D');
    assert.strictEqual(aliasFor('../../../../x/y', 'a/b/c/d/e.ts'), '@/x/y');
});

test('aliasFor leaves shallow specifiers, packages, the alias itself and paths that leave src', () => {
    assert.strictEqual(aliasFor('../../utils/helpers', 'components/a/b.ts'), null);
    assert.strictEqual(aliasFor('./x', 'components/a/b.ts'), null);
    assert.strictEqual(aliasFor('react', 'components/a/b.ts'), null);
    assert.strictEqual(aliasFor('@/utils/helpers', 'components/a/b.ts'), null);
    // From components/a/b.ts, ../../../../ is the directory above src/.
    assert.strictEqual(aliasFor('../../../../server/x.js', 'components/a/b/c.ts'), null);
    assert.strictEqual(aliasFor('../../../../../anything', 'components/a/b/c.ts'), null);
    // src/ itself has no file to name.
    assert.strictEqual(aliasFor('../../../', 'components/a/b/c.ts'), null);
});

tsTest('every import form is rewritten and only the text between the quotes changes', () => {
    const src = [
        "import a from '../../../a';",
        'import { b } from "../../../b.js";',
        "import type { C } from '../../../c';",
        "import '../../../side-effect';",
        "export * from '../../../d';",
        "export { e } from '../../../e';",
        "const f = await import('../../../f');",
        "const g = lazy(() => import('../../../g'));",
        "const h = require('../../../h');",
        "type I = import('../../../i').I;",
        "vi.mock('../../../j', () => ({}));",
        "vi.doMock('../../../k');",
        "const l = await vi.importActual('../../../l');",
        "jest.mock('../../../m');",
        'vi.mock(`../../../n`);',
        "vi.mock(import('../../../o'));",
        '',
    ].join('\n');
    const out = rewrite(src, 'components/x/y/z.ts');
    assert.strictEqual(
        out,
        src.replace(/(['"`])\.\.\/\.\.\/\.\.\/([a-z][\w.-]*)\1/g, '$1@/$2$1').replace(/'\.\.\/\.\.\/\.\.\/\.\.\//g, "'@/"),
    );
    assert.doesNotMatch(out, /\.\.\//);
});

tsTest('a path that is not a module specifier is left alone', () => {
    const src = [
        "// see import x from '../../../x' in the docs",
        "/** @param {import('../../../y').Y} y */",
        "const sample = \"import z from '../../../z'\";",
        'const tpl = `import w from "../../../w"`;',
        "const dir = path.resolve(__dirname, '../../../utils');",
        "const url = new URL('../../../asset.svg', import.meta.url);",
        "vi.mocked(thing, '../../../v');",
        "other.mock('../../../u');",
        '',
    ].join('\n');
    assert.deepStrictEqual(deepSpecifiers(src, 'components/x/y/z.ts'), []);
});

tsTest('a specifier that leaves src stays, the others in the same file move', () => {
    const src = "import a from '../../../../server/a.js';\nimport b from '../../../b';\n";
    assert.strictEqual(rewrite(src, 'components/x/y/z.ts'), "import a from '../../../../server/a.js';\nimport b from '@/b';\n");
});

tsTest('several specifiers on one line all move', () => {
    const src = "const [a, b] = await Promise.all([import('../../../a'), import('../../../b')]);\n";
    assert.strictEqual(rewrite(src, 'p/q/r/s.tsx'), "const [a, b] = await Promise.all([import('@/a'), import('@/b')]);\n");
});

tsTest('JSX and TSX files parse', () => {
    assert.strictEqual(rewrite("import X from '../../../X';\nexport const A = () => <X a={1} />;\n", 'a/b/c/d.jsx'), "import X from '@/X';\nexport const A = () => <X a={1} />;\n");
    assert.strictEqual(rewrite("import X from '../../../X';\nexport const A = <T,>(p: T) => <X />;\n", 'a/b/c/d.tsx'), "import X from '@/X';\nexport const A = <T,>(p: T) => <X />;\n");
});

function sandbox(files, manifest = { entries: [] }, exclude = { files: [] }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imports-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(HERE, 'deep-imports.mjs'), path.join(dir, 'scripts/deep-imports.mjs'));
    fs.writeFileSync(path.join(dir, 'scripts/shared-mirror.manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'scripts/deep-imports.exclude.json'), JSON.stringify(exclude));
    fs.symlinkSync(path.join(HERE, '..', 'node_modules'), path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, 'agent-hub/src', rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    return dir;
}

const run = (dir, args = []) => execFileSync(process.execPath, [path.join(dir, 'scripts/deep-imports.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
const read = (dir, rel) => fs.readFileSync(path.join(dir, 'agent-hub/src', rel), 'utf8');

const DEEP = "import { x } from '../../../utils/x';\n";

tsTest('the excluded files keep their relative imports: mirror sources, mirror targets and the listed files', () => {
    const dir = sandbox(
        {
            'a/b/c/plain.ts': DEEP,
            'a/b/c/mirrored.ts': DEEP,
            'a/b/c/mapping/one.ts': DEEP,
            'shared/gen/deep/target.ts': DEEP,
            'a/b/c/mobileRuns.ts': DEEP,
        },
        {
            entries: [
                { source: 'agent-hub/src/a/b/c/mirrored.ts', target: 'mobile/src/mirror/mirrored.ts' },
                { source: 'agent-hub/src/a/b/c/mapping', target: 'mobile/src/mirror/mapping' },
                { source: 'server/shared/gen', target: 'agent-hub/src/shared/gen' },
            ],
        },
        { files: ['a/b/c/mobileRuns.ts'] },
    );
    const out = run(dir);
    assert.match(out, /rewrote 1 specifiers in 1 files; 4 left alone in excluded files/);
    assert.strictEqual(read(dir, 'a/b/c/plain.ts'), "import { x } from '@/utils/x';\n");
    for (const f of ['a/b/c/mirrored.ts', 'a/b/c/mapping/one.ts', 'shared/gen/deep/target.ts', 'a/b/c/mobileRuns.ts']) assert.strictEqual(read(dir, f), DEEP, f);
    assert.deepStrictEqual([...excludedFiles(dir)].sort(), ['a/b/c/mapping/one.ts', 'a/b/c/mirrored.ts', 'a/b/c/mobileRuns.ts', 'shared/gen/deep/target.ts']);
});

tsTest('--dry writes nothing and a second run changes nothing', () => {
    const dir = sandbox({ 'a/b/c/f.ts': DEEP });
    assert.match(run(dir, ['--dry']), /a\/b\/c\/f\.ts: \.\.\/\.\.\/\.\.\/utils\/x -> @\/utils\/x/);
    assert.strictEqual(read(dir, 'a/b/c/f.ts'), DEEP);
    run(dir);
    assert.match(run(dir), /rewrote 0 specifiers in 0 files/);
});

tsTest('given files, only those are rewritten', () => {
    const dir = sandbox({ 'a/b/c/f.ts': DEEP, 'a/b/c/g.ts': DEEP });
    run(dir, [path.join(dir, 'agent-hub/src/a/b/c/f.ts')]);
    assert.strictEqual(read(dir, 'a/b/c/f.ts'), "import { x } from '@/utils/x';\n");
    assert.strictEqual(read(dir, 'a/b/c/g.ts'), DEEP);
});

test('the real exclusion list names only files that exist and no folder', () => {
    const root = path.join(HERE, '..');
    const listed = JSON.parse(fs.readFileSync(path.join(HERE, 'deep-imports.exclude.json'), 'utf8')).files;
    assert.ok(listed.length > 0);
    assert.deepStrictEqual(listed, [...listed].sort(), 'keep the list sorted');
    for (const f of listed) {
        assert.ok(fs.statSync(path.join(root, 'agent-hub/src', f)).isFile(), `${f} is not a file under agent-hub/src`);
    }
});
