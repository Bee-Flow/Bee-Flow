import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsc } from './ts-convert-gate.mjs';

test('tsc output lines become file, line, code and message', () => {
    const out = "src/a.tsx(3,5): error TS2339: Property 'x' does not exist on type 'Y'.\nnoise\nsrc/b/c.ts(10,1): error TS7006: Parameter 'v' implicitly has an 'any' type.\n";
    assert.deepEqual(parseTsc(out), [
        { file: 'src/a.tsx', line: 3, code: 'TS2339', message: "Property 'x' does not exist on type 'Y'." },
        { file: 'src/b/c.ts', line: 10, code: 'TS7006', message: "Parameter 'v' implicitly has an 'any' type." },
    ]);
});

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbidden } from './ts-convert-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }

test('the gate names every forbidden construct, and only new eslint-disables', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const src = 'const a: any = 1; const b = x as never[]; const c = y as unknown as Z; const d = e!.f; let g: Function;\n// @ts-ignore\n// eslint-disable-next-line no-x\n';
    assert.deepEqual(forbidden(ts, src).sort(), ['// eslint-disable-next-line no-x'.slice(3), '@ts-ignore', 'Function', 'any', 'as never', 'as unknown as', 'non-null !'].sort());
    assert.deepEqual(forbidden(ts, '// eslint-disable-next-line no-x\nconst a = 1 as number;\n', '// eslint-disable-next-line no-x\n'), []);
});
