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
