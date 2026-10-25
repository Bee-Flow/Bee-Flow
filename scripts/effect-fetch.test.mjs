import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The parser is the TypeScript compiler API (root typescript-api, else agent-hub's).
let hasTs = false;
for (const [from, name] of [['../package.json', 'typescript-api'], ['../agent-hub/package.json', 'typescript']]) {
    try { createRequire(new URL(from, import.meta.url))(name); hasTs = true; break; } catch { /* not installed */ }
}
const test = hasTs ? nodeTest : nodeTest.skip;
const { fetchInEffect } = hasTs ? await import('./effect-fetch.mjs') : {};

test('a direct authFetch in an effect counts; one in a click handler does not', () => {
    assert.equal(fetchInEffect(`useEffect(() => { authFetch('/api/x').then(setX); }, []);`), 1);
    assert.equal(fetchInEffect(`const onClick = () => authFetch('/api/x'); useEffect(() => { setY(1); }, []);`), 0);
});

test('a fetch moved into an api/ helper still counts when the effect calls it', () => {
    const src = `import { mutate } from '../../api/mutate';
useEffect(() => { mutate('/api/x', { method: 'POST' }); }, []);`;
    assert.equal(fetchInEffect(src), 1);
});

test('an effect calling a local loader that fetches counts, through a useCallback too', () => {
    const src = `const load = useCallback(async () => { const r = await authFetch('/api/x'); setX(await r.json()); }, []);
useEffect(() => { load(); }, [load]);`;
    assert.equal(fetchInEffect(src), 1);
});

test('a react-query hook from api/ is the replacement, not the pattern', () => {
    const src = `import { useThingQuery } from '../api/queries/thing';
const q = useThingQuery(id);
useEffect(() => { if (q.data) setDraft(q.data); }, [q.data]);`;
    assert.equal(fetchInEffect(src), 0);
});

test('a type-only import from api/ is not a call', () => {
    const src = `import type { Thing } from '../api/thing';
const Thing = () => 1;
useEffect(() => { Thing(); }, []);`;
    assert.equal(fetchInEffect(src), 0);
});
