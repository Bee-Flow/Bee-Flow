import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from './ts-runtime-recorder.mjs';
import { instrument, typeFromSamples } from './ts-runtime-types.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }

test('values are described, never kept', () => {
    assert.deepEqual(describe('x'), { k: 'string' });
    assert.deepEqual(describe(null), { k: 'null' });
    assert.deepEqual(describe(() => 1), { k: 'fn' });
    assert.deepEqual(describe([1, 2, 'a']), { k: 'arr', e: [{ k: 'number' }, { k: 'string' }] });
    assert.deepEqual(describe({ id: 'a', n: 1 }), { k: 'obj', p: { id: { k: 'string' }, n: { k: 'number' } } });
    assert.deepEqual(describe(new Date()), { k: 'class', name: 'Date' });
    assert.deepEqual(describe({ $$typeof: Symbol.for('react.element') }), { k: 'node' });
});

test('observations become a type: unions, optional keys, arrays, named shapes', () => {
    const s = { k: 'string' }; const n = { k: 'number' };
    assert.equal(typeFromSamples([s, n]), 'string | number');
    assert.equal(typeFromSamples([s, { k: 'null' }]), 'string | null');
    const opts = {}; assert.equal(typeFromSamples([s, { k: 'undefined' }], undefined, 0, opts), 'string'); assert.equal(opts.optional, true);
    assert.equal(typeFromSamples([{ k: 'obj', p: { id: s, n } }, { k: 'obj', p: { id: s } }]), '{ id: string; n?: number }');
    assert.equal(typeFromSamples([{ k: 'arr', e: [s, n] }]), '(string | number)[]');
    assert.equal(typeFromSamples([{ k: 'obj', p: { id: s, name: s } }], () => 'User'), 'User');
});

test('what says nothing or cannot be written is refused', () => {
    assert.equal(typeFromSamples([{ k: 'null' }]), null);
    assert.equal(typeFromSamples([{ k: 'fn' }]), null);
    assert.equal(typeFromSamples([{ k: 'arr', e: [] }]), null);
    assert.equal(typeFromSamples([{ k: 'class', name: 'SyntheticBaseEvent' }]), null);
    assert.equal(typeFromSamples([{ k: 'class', name: 'Map' }]), null); // needs type arguments
});

test('instrumentation records parameters, props and state without touching the logic', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const src = 'export function Card({ label }) { const [n, setN] = useState(null); return label; }\nconst f = (a, b) => a + b;\n';
    const out = instrument(ts, src, 'src/Card.jsx');
    assert.match(out, /function Card\(\{ label \}\) \{__tcRec\("src\/Card\.jsx", "Card#0", \{ "\.label": label \}\);/);
    assert.match(out, /const \[n, setN\] = useState\(null\); __tcRec\("src\/Card\.jsx", "state:setN", \{ "=": n \}\);/);
    assert.match(out, /const f = \(a, b\) => \{ __tcRec\("src\/Card\.jsx", "f#0", \{ "#0": a, "#1": b \}\); return \(a \+ b\); \}/);
});
