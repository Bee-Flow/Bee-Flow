import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countAny, fixFiles, insertsAny } from './ts-fix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }
const skip = !ts && 'agent-hub typescript not installed';

function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-fix-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src/**/*'] }));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'src', name), text);
    return dir;
}

test('insertsAny sees the keyword, not comments or longer words', () => {
    assert.equal(insertsAny(': any'), true);
    assert.equal(insertsAny(': Array<any>'), true);
    assert.equal(insertsAny(': company /* any */'), false);
    assert.equal(insertsAny(': number'), false);
});

test('countAny counts keywords in the parse', { skip }, () => {
    assert.equal(countAny(ts, 'let a: any; let b = c as any; // any'), 2);
});

test('inferFromUsage types a parameter from its use; a fix that needs any is dropped', { skip }, () => {
    const dir = fixture({ 'a.ts': 'export function g(n) { return n * 2; }\nexport function p(x) { return x.zzz; }\n' });
    const file = path.join(dir, 'src/a.ts');
    const [r] = fixFiles(ts, [file], ['inferFromUsage'], { root: dir });
    assert.equal(r.changed, true);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /function g\(n: number\)/);
    assert.match(text, /function p\(x\)/); // untouched: the only fix would be { zzz: any }
    assert.ok(r.skipped.some((s) => /adds any/.test(s.reason)));
    // With --allow-any the second one is written too.
    const [r2] = fixFiles(ts, [file], ['inferFromUsage'], { root: dir, allowAny: true });
    assert.equal(r2.changed, true);
    assert.match(fs.readFileSync(file, 'utf8'), /function p\(x: \{ zzz: any; \}\)/);
});

test('missing import, async, missing member and JSDoc fixes; --dry writes nothing', { skip }, () => {
    const src = [
        'export const v = helper();',
        'export function h() { const r = await Promise.resolve(1); return r; }',
        '/** @param {string} s */',
        'export function k(s) { return s; }',
        'export class C { m() { this.foo = 1; } }',
        '',
    ].join('\n');
    const dir = fixture({ 'c.ts': 'export function helper(): number { return 1; }\n', 'a.ts': src });
    const file = path.join(dir, 'src/a.ts');
    const ids = ['fixMissingImport', 'fixAwaitInSyncFunction', 'annotateWithTypeFromJSDoc', 'fixAddMissingMember'];
    const [dry] = fixFiles(ts, [file], ids, { root: dir, dry: true });
    assert.equal(dry.changed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), src);
    assert.deepEqual([...new Set(dry.applied.map((a) => a.fixId))].sort(), ['annotateWithTypeFromJSDoc', 'fixAwaitInSyncFunction', 'fixMissingImport', 'fixMissingMember'].sort());
    const [real] = fixFiles(ts, [file], ids, { root: dir });
    assert.equal(real.changed, true);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /import \{ helper \} from '\.\/c';/);
    assert.match(text, /export async function h\(\)/);
    assert.match(text, /function k\(s: string\)/);
    assert.match(text, /foo: number;/);
    // A clean file is reported unchanged.
    const [again] = fixFiles(ts, [file], ids, { root: dir });
    assert.equal(again.changed, false);
});
