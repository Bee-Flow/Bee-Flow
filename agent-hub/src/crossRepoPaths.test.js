// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard: every path this package builds INTO the server tree still resolves.
 *
 * A handful of tests read server source directly to pin a cross-repo contract
 * (the automation node labels the server emits, the expression-function list,
 * the engine's edge-building rules). They locate it with
 * `path.resolve(HERE, '../../../../../../server/...')` — a count of `..`
 * segments, not an import specifier.
 *
 * That count is invisible to every tool that rewrites imports when a file
 * moves, and it fails at RUN time with an ENOENT deep inside a test body
 * rather than at resolve time. Moving components/admin/AITasksDesigner to
 * components/automation made the tree one level shallower and broke all three
 * at once; nothing caught it until the suite ran.
 *
 * The same hazard is documented for the server package in
 * server/ARCHITECTURE.md ("Module ids that are not require calls").
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = HERE;
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, out); }
        else if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(e.name)) out.push(full);
    }
    return out;
}

// A quoted relative path that walks up at least twice and names the server
// package — i.e. the shape used to reach across the repo.
// The hazard is a path built from SEGMENTS and handed to path.resolve/join —
// located by position rather than by module id. Import specifiers are NOT
// scanned: those already fail loudly at resolve time (tsc, vitest, the
// import-resolution check). These do not; they fail with an ENOENT inside a
// test body, if that line runs at all.
//
// It has now broken three times on this branch: three tests reaching into
// server/, MarkdownRenderer reading ../index.css, and AppIcon.registry walking
// up to the repo root — each time because a move changed the file's depth.
const PATH_CALL = /\bpath\.(?:resolve|join)\(([^)]*)\)/g;
const REL_ARG = /(['"])(\.\.?\/[^'"]*)\1/g;

// The specifier may omit the extension (require/createRequire both add it), so
// resolve the way Node would rather than stat-ing the bare string.
const EXTS = ['', '.js', '.mjs', '.cjs', '.json', '.jsx'];
function resolves(base) {
    if (EXTS.some(e => fs.existsSync(base + e))) return true;
    return EXTS.slice(1).some(e => fs.existsSync(path.join(base, 'index' + e)));
}

describe('cross-repo paths', () => {
    it('every ../-built path into server/ resolves to a real file', () => {
        const broken = [];
        for (const file of walk(SRC)) {
            if (file === fileURLToPath(import.meta.url)) continue;   // our own example path
            const src = fs.readFileSync(file, 'utf8');
            for (const call of src.matchAll(PATH_CALL)) {
              for (const m of String(call[1]).matchAll(REL_ARG)) {
                const target = path.resolve(path.dirname(file), m[2]);
                if (!resolves(target)) {
                    broken.push(`${path.relative(SRC, file)}  ->  ${m[2]}`);
                }
              }
            }
        }
        expect(broken, `unresolvable cross-repo paths:\n  ${broken.join('\n  ')}`).toEqual([]);
    });
});
