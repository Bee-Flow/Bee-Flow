import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireLock, applyCasts, castLoop, findCasts, isLocked, LOCK_NAME, makeTscRunner, waitForLock } from './ts-cast-loop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');
let ts = null;
try { ts = createRequire(path.join(HUB, 'package.json'))('typescript'); } catch { /* not installed */ }
const tscPath = ['typescript-7', 'typescript'].map((m) => path.join(HUB, 'node_modules', m, 'bin', 'tsc')).find((p) => fs.existsSync(p));
const skip = (!ts || !tscPath) && 'agent-hub typescript not installed';

test('findCasts and applyCasts remove the cast and keep the operand', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const text = "const a = (x as any).y;\nconst b = f(z) as unknown as number;\nconst c = <any>w;\nconst d = q as string;\n";
    const casts = findCasts(ts, 'a.ts', text, ['as unknown as', 'as any', '<any>']);
    assert.deepEqual(casts.map((c) => c.pattern), ['as any', 'as unknown as', '<any>']);
    assert.equal(applyCasts(text, casts), 'const a = x.y;\nconst b = f(z);\nconst c = w;\nconst d = q as string;\n');
    assert.equal(findCasts(ts, 'a.ts', text, ['as unknown as']).length, 1);
    // A complex operand keeps its parentheses.
    const t2 = 'const e = (a || b as any).c;';
    assert.equal(applyCasts(t2, findCasts(ts, 'a.ts', t2, ['as any'])), 'const e = (a || b).c;');
});

test('the loop keeps removals that typecheck and reverts the rest with the error', { skip }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cast-loop-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, lib: ['ES2022'] }, include: ['src/**/*'] }));
    const good = ['export const n = (1 as unknown as number);', 'export const s = ("a" as any).length;'].join('\n') + '\n';
    const mixed = [
        'const obj = { a: 1 };',
        'export const ok = (obj as any).a;',          // removable
        'export const bad: number = "text" as unknown as number;', // needed: string is not a number
        'export const bad2: number = JSON.parse("1") as any;', // removable: any assigns to number? no cast: any stays any
        'export const needed: string = ({} as any);',  // removable too ({} is not string -> error)
        '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'src/good.ts'), good);
    fs.writeFileSync(path.join(dir, 'src/mixed.ts'), mixed);
    process.env.TS_CAST_LOOP_NO_HEAVY = '1';
    const { report } = castLoop(ts, dir, ['src/good.ts', 'src/mixed.ts'], { runTsc: makeTscRunner(dir, tscPath) });
    assert.equal(report.baselineErrors, 0);
    assert.deepEqual(report.kept.map((c) => `${c.file}:${c.line}`).sort(), ['src/good.ts:1', 'src/good.ts:2', 'src/mixed.ts:2', 'src/mixed.ts:4'].sort());
    assert.deepEqual(report.reverted.map((c) => `${c.file}:${c.line}`).sort(), ['src/mixed.ts:3', 'src/mixed.ts:5']);
    assert.match(report.reverted[0].error, /src\/mixed\.ts:\d+ TS\d+/);
    assert.equal(report.finalNewErrors, 0);
    assert.ok(report.runs >= 4);
    // Files on disk: kept removals applied, reverted casts back.
    assert.equal(fs.readFileSync(path.join(dir, 'src/good.ts'), 'utf8'), 'export const n = (1);\nexport const s = ("a").length;\n');
    const m = fs.readFileSync(path.join(dir, 'src/mixed.ts'), 'utf8');
    assert.match(m, /export const ok = obj\.a;/);
    assert.match(m, /"text" as unknown as number/);
});

test('--dry restores every file', { skip }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cast-loop-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, lib: ['ES2022'] }, include: ['src/**/*'] }));
    const text = 'export const n = (1 as unknown as number);\n';
    fs.writeFileSync(path.join(dir, 'src/a.ts'), text);
    process.env.TS_CAST_LOOP_NO_HEAVY = '1';
    const { report } = castLoop(ts, dir, ['src/a.ts'], { runTsc: makeTscRunner(dir, tscPath), dry: true });
    assert.equal(report.kept.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8'), text);
});

test('lock file: written with the pid, a second holder is refused, release removes it, a dead pid is stale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cast-lock-'));
    assert.equal(isLocked(dir), null);
    const release = acquireLock(dir, { package: '/p', files: ['a.ts'] });
    const info = isLocked(dir);
    assert.equal(info.pid, process.pid);
    assert.deepEqual(info.files, ['a.ts']);
    assert.throws(() => acquireLock(dir, {}), /already running/);
    release();
    release(); // idempotent
    assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
    // stale: a pid that does not exist
    fs.writeFileSync(path.join(dir, LOCK_NAME), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 'x' }));
    assert.equal(isLocked(dir), null);
    const again = acquireLock(dir, {});
    assert.equal(isLocked(dir).pid, process.pid);
    again();
    // waiting: free at once, and times out while a live lock stays
    assert.equal(await waitForLock(dir, { timeoutMs: 50, pollMs: 10 }), true);
    const held = acquireLock(dir, {});
    assert.equal(await waitForLock(dir, { timeoutMs: 60, pollMs: 10 }), false);
    setTimeout(held, 40);
    assert.equal(await waitForLock(dir, { timeoutMs: 2000, pollMs: 10 }), true);
});

test('CLI: refuses to start under a live lock (exit 3); --wait-lock exits 0 when free, 1 on timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cast-lock-'));
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ts-cast-loop.mjs');
    const free = spawnSync(process.execPath, [script, '--wait-lock', dir], { encoding: 'utf8' });
    assert.equal(free.status, 0, free.stderr);
    fs.writeFileSync(path.join(dir, LOCK_NAME), JSON.stringify({ pid: process.pid, startedAt: 'now' }));
    const timeout = spawnSync(process.execPath, [script, '--wait-lock', dir, '--timeout', '1'], { encoding: 'utf8' });
    assert.equal(timeout.status, 1);
    if (!ts) return;
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cast-pkg-'));
    fs.mkdirSync(path.join(pkg, 'src'));
    fs.writeFileSync(path.join(pkg, 'src/a.ts'), 'export const n = (1 as any);\n');
    const refused = spawnSync(process.execPath, [script, pkg, '--files', 'src/a.ts', '--lock-dir', dir, '--dry'], { encoding: 'utf8' });
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /already running/);
    assert.equal(fs.readFileSync(path.join(pkg, 'src/a.ts'), 'utf8'), 'export const n = (1 as any);\n', 'nothing touched');
});
