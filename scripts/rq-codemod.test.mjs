import nodeTest from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The policy job runs the repo-script tests with only the root packages, so
// without agent-hub's typescript these tests skip (as ts-move-types.test.mjs does).
let hasTs = false;
try { createRequire(new URL('../agent-hub/package.json', import.meta.url))('typescript'); hasTs = true; } catch { /* not installed */ }
const test = hasTs ? nodeTest : nodeTest.skip;
const { run } = hasTs ? await import('./rq-codemod.mjs') : {};

/** A throw-away `src/` tree; returns the root and a path helper. */
function sandbox(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-codemod-'));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return { root, at: (rel) => path.join(root, rel) };
}

const CANONICAL = `import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';

interface Props { orgId: string | null }

export default function OrgHealth({ orgId }: Props) {
    const [rows, setRows] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!orgId) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await authFetch(\`\${API_BASE}/api/orgs/\${encodeURIComponent(orgId)}/health\`);
                if (!res.ok) { if (!cancelled) setError(\`Failed (\${res.status})\`); return; }
                const json = await res.json();
                if (!cancelled) setRows(Array.isArray(json.rows) ? json.rows : []);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Failed');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [orgId]);

    if (loading) return <p>loading</p>;
    if (error) return <p>{error}</p>;
    return <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>;
}
`;

test('query: the canonical effect becomes a hook and the component reads it', () => {
    const sb = sandbox({
        'src/components/org/OrgHealth.tsx': CANONICAL,
        'src/components/org/OrgHealth.test.tsx': "import OrgHealth from './OrgHealth';\nimport { render } from '@testing-library/react';\nrender(<OrgHealth orgId=\"a\" />);\n",
    });
    const file = sb.at('src/components/org/OrgHealth.tsx');
    const r = run([file], { mode: 'query', dry: true });
    assert.deepEqual(r.skipped, []);
    assert.equal(r.converted.length, 1);
    assert.equal(r.summary.query.converted, 1);

    const hookFile = sb.at('src/api/queries/org.ts');
    const hook = r.texts[hookFile];
    assert.ok(hook, 'a hook file is produced');
    assert.match(hook, /export const orgKeys = \{/);
    assert.match(hook, /export function useOrgsHealth|export function useOrgsOrgIdHealth|export function use\w*Health\(orgId: string \| null\)/);
    assert.match(hook, /useQuery<string\[\], Error>/);
    assert.match(hook, /enabled: !!orgId/);
    assert.match(hook, /await authFetch\(`\$\{API_BASE\}\/api\/orgs\/\$\{encodeURIComponent\(orgId\)\}\/health`\)/, 'authFetch stays inside queryFn');
    assert.match(hook, /if \(orgId == null\) throw/);
    assert.match(hook, /retry: false/);
    assert.match(hook, /import \{ ApiError \} from '\.\.\/client'/);

    const comp = r.texts[file];
    assert.ok(comp);
    assert.doesNotMatch(comp, /useEffect|authFetch|useState/);
    assert.match(comp, /const rowsQuery = use\w+Health\(orgId\);/);
    assert.match(comp, /const rows = rowsQuery\.data \?\? EMPTY_ROWS;/);
    assert.match(comp, /const EMPTY_ROWS: string\[\] = \[\];/);
    assert.match(comp, /const loading = rowsQuery\.isFetching;/);
    assert.match(comp, /queryError instanceof ApiError \? `Failed \(\$\{queryError\.status\}\)` : /);
    assert.match(comp, /from '\.\.\/\.\.\/api\/queries\/org'/);
    assert.doesNotMatch(comp, /\n\n\n/, 'no blank-line debris from the removed imports and state');
    assert.match(comp, /queryError \? \(queryError instanceof ApiError \? /);

    // tests that render the component without a QueryClient are listed, not rewritten
    assert.equal(r.testsNeedingClient.length, 1);
    assert.match(r.testsNeedingClient[0].test, /OrgHealth\.test\.tsx$/);
    // --dry wrote nothing
    assert.equal(fs.readFileSync(file, 'utf8'), CANONICAL);
    assert.equal(fs.existsSync(hookFile), false);
});

test('query: a real run writes the hook and the component, and reuses the hook file', () => {
    const sb = sandbox({
        'src/components/org/OrgHealth.tsx': CANONICAL,
        'src/api/queries/org.ts': "import { useQuery } from '@tanstack/react-query';\n\nexport const orgKeys = {\n    all: ['org'] as const,\n};\n\nexport function useExisting() {\n    return useQuery({ queryKey: orgKeys.all, queryFn: async () => 1 });\n}\n",
    });
    const file = sb.at('src/components/org/OrgHealth.tsx');
    const r = run([file], { mode: 'query' });
    assert.equal(r.converted.length, 1);
    const hook = fs.readFileSync(sb.at('src/api/queries/org.ts'), 'utf8');
    assert.match(hook, /useExisting/);
    assert.match(hook, /all: \['org'\] as const,\n    \w+: \(orgId: string \| null\) => \['org', '\w+', orgId\] as const,/);
    assert.equal((hook.match(/from '@tanstack\/react-query'/g) || []).length, 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /useEffect/);
});

test('query: several setters fed by one response become one hook returning an object', () => {
    const src = `import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';

export default function Beta() {
    const [loading, setLoading] = useState(true);
    const [allowed, setAllowed] = useState<string[]>([]);
    const [count, setCount] = useState<number | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(\`\${API_BASE}/auth/me/features\`);
                if (res.ok) {
                    const data = await res.json();
                    setAllowed(Array.isArray(data.allowed) ? data.allowed : []);
                    setCount(data.count);
                }
            } catch (e) {
                console.error('load error', e);
            } finally {
                setLoading(false);
            }
        })();
    }, []);
    return <p>{loading ? '...' : allowed.length + String(count)}</p>;
}
`;
    const sb = sandbox({ 'src/pages/settings/Beta.tsx': src });
    const file = sb.at('src/pages/settings/Beta.tsx');
    const r = run([file], { mode: 'query', dry: true });
    assert.deepEqual(r.skipped, []);
    const hook = r.texts[sb.at('src/api/queries/settings.ts')];
    assert.match(hook, /useQuery<\{ allowed: string\[\]; count: number \}, Error>/);
    assert.match(hook, /return \{ allowed: Array\.isArray\(data\.allowed\) \? data\.allowed : \[\], count: data\.count \};/);
    const comp = r.texts[file];
    assert.match(comp, /const allowedQuery = use\w+\(\);/);
    assert.match(comp, /const allowed = allowedQuery\.data\?\.allowed \?\? EMPTY_ALLOWED;/);
    assert.match(comp, /const count = allowedQuery\.data\?\.count \?\? null;/);
    assert.match(comp, /const loading = allowedQuery\.isFetching;/);
});

test('query: shapes outside the canonical one are skipped with a reason', () => {
    const src = `import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';

export default function Thing() {
    const [items, setItems] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        (async () => {
            const res = await authFetch(\`\${API_BASE}/api/things\`);
            setItems(await res.json());
        })();
    }, []);
    return <button disabled={busy} onClick={() => { setItems([]); setBusy(true); }}>{items.length}</button>;
}
`;
    const sb = sandbox({ 'src/components/things/Thing.tsx': src });
    const r = run([sb.at('src/components/things/Thing.tsx')], { mode: 'query', dry: true });
    assert.equal(r.converted.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, 'setter used outside the effect');
    assert.deepEqual(r.texts, {});
});

test('query: a data type that lives in components/ cannot be imported by api/', () => {
    const src = `import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { Row } from './rowTypes';
export default function Rows() {
    const [rows, setRows] = useState<Row[]>([]);
    useEffect(() => {
        authFetch(\`\${API_BASE}/api/rows\`).then((r) => r.json()).then((d) => setRows(d));
    }, []);
    return <p>{rows.length}</p>;
}
`;
    const sb = sandbox({ 'src/components/rows/Rows.tsx': src });
    const r = run([sb.at('src/components/rows/Rows.tsx')], { mode: 'query', dry: true });
    assert.equal(r.converted.length, 0);
    assert.match(r.skipped[0].reason, /components\/ or pages\//);
});

test('query: a mutation inside the effect is not a query', () => {
    const src = `import { useEffect } from 'react';
import { authFetch } from '../../utils/helpers';
export default function Ping() {
    useEffect(() => { authFetch('/api/ping', { method: 'POST' }); }, []);
    return null;
}
`;
    const sb = sandbox({ 'src/components/ping/Ping.tsx': src });
    const r = run([sb.at('src/components/ping/Ping.tsx')], { mode: 'query', dry: true });
    assert.equal(r.skipped[0].reason, 'mutation inside the effect');
});

const MUTATION = `import { useState } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';

export default function Rename({ id }: { id: string }) {
    const [error, setError] = useState<string | null>(null);

    const save = async (name: string) => {
        try {
            const res = await authFetch(\`\${API_BASE}/api/things/\${id}\`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) {
                setError(\`Failed (\${res.status})\`);
                return;
            }
            const body = await res.json();
            console.log(body);
        } catch (e) {
            setError(String(e));
        }
    };
    return <button onClick={() => save('x')}>{error}</button>;
}
`;

test('mutation: a res.ok branch becomes mutate() with a catch of RefusedError', () => {
    const sb = sandbox({ 'src/components/things/Rename.tsx': MUTATION });
    const file = sb.at('src/components/things/Rename.tsx');
    const r = run([file], { mode: 'mutation', dry: true });
    assert.deepEqual(r.skipped, []);
    assert.equal(r.converted.length, 1);
    const out = r.texts[file];
    assert.match(out, /import \{ API_BASE \} from '\.\.\/\.\.\/utils\/helpers';/);
    assert.match(out, /import \{ mutate, RefusedError \} from '\.\.\/\.\.\/api\/mutate';/);
    assert.match(out, /\n( +)let res: Response;\n\1try \{\n\1    res = await mutate/);
    assert.match(out, /\n( +)\} catch \(err\) \{\n\1    if \(!\(err instanceof RefusedError\)\) throw err;\n\1    setError/);
    assert.match(out, /let res: Response;\n\s+try \{\n\s+res = await mutate\(`\$\{API_BASE\}\/api\/things\/\$\{id\}`, \{/);
    assert.match(out, /\} catch \(err\) \{\n\s+if \(!\(err instanceof RefusedError\)\) throw err;\n\s+setError\(`Failed \(\$\{err\.status\}\)`\);\n\s+return;\n\s+\}/);
    assert.match(out, /const body = await res\.json\(\);/);
    assert.doesNotMatch(out, /authFetch/);
});

test('mutation: the else branch of res.ok keeps its shape', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export async function remove(id: string, done: () => void, fail: () => void) {
    const res = await authFetch('/api/things/' + id, { method: 'DELETE' });
    if (res.ok) {
        done();
    } else {
        fail();
    }
}
`;
    const sb = sandbox({ 'src/components/things/remove.ts': src });
    const file = sb.at('src/components/things/remove.ts');
    const r = run([file], { mode: 'mutation', dry: true });
    assert.equal(r.converted.length, 1);
    const out = r.texts[file];
    assert.match(out, /const res = await mutate\('\/api\/things\/' \+ id, \{ method: 'DELETE' \}\)\.catch\(/);
    assert.match(out, /if \(res\) \{/);
});

test('mutation: skipped when the Response is ignored or its body is read on failure', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export async function a() {
    await authFetch('/api/a', { method: 'POST' });
}
export async function b(set: (s: string) => void) {
    const res = await authFetch('/api/b', { method: 'POST' });
    if (!res.ok) {
        const body = await res.json();
        set(body.error);
        return;
    }
}
export async function c(set: (s: string) => void) {
    const res = await authFetch('/api/c', { method: 'POST' });
    if (!res.ok) set('x');
    return res.json();
}
`;
    const sb = sandbox({ 'src/components/x/m.ts': src });
    const r = run([sb.at('src/components/x/m.ts')], { mode: 'mutation', dry: true });
    assert.equal(r.converted.length, 0);
    assert.deepEqual(r.skipped.map((s) => s.reason), [
        'Response ignored (unchecked)',
        'non-ok branch parses JSON without a fallback',
        'non-ok branch falls through',
    ]);
});

test('files in src/api and test files are left alone', () => {
    const sb = sandbox({
        'src/api/thing.ts': "import { authFetch } from '../utils/helpers';\nexport async function p() { const res = await authFetch('/x', { method: 'POST' }); if (!res.ok) throw new Error('x'); }\n",
        'src/components/x/y.test.tsx': "import { authFetch } from '../../utils/helpers';\nasync function p() { const res = await authFetch('/x', { method: 'POST' }); if (!res.ok) throw new Error('x'); }\n",
    });
    const r = run([sb.at('src/api/thing.ts'), sb.at('src/components/x/y.test.tsx')], { mode: 'both', dry: true });
    assert.equal(r.converted.length + r.skipped.length, 0);
});

test('mutation: json first, then the ok check -> the body is rebuilt from the RefusedError', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export async function save(set: (s: string) => void) {
    const res = await authFetch('/api/x', { method: 'POST', body: '{}' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        set(body.error || \`Failed (\${res.status})\`);
        return null;
    }
    return body.id;
}
`;
    const sb = sandbox({ 'src/components/x/save.ts': src });
    const file = sb.at('src/components/x/save.ts');
    const r = run([file], { mode: 'mutation', dry: true });
    assert.deepEqual(r.skipped, []);
    assert.equal(r.converted.length, 1);
    const out = r.texts[file];
    for (const name of ['mutate', 'RefusedError', 'errorBody']) assert.match(out, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\.\\./\\.\\./api/mutate';`));
    assert.match(out, /let res: Response;\n\s+try \{\n\s+res = await mutate\('\/api\/x', \{ method: 'POST', body: '\{\}' \}\);/);
    assert.match(out, /\} catch \(err\) \{\n\s+if \(!\(err instanceof RefusedError\)\) throw err;\n\s+const body = errorBody\(err\) \?\? \{\};\n\s+set\(body\.error \|\| `Failed \(\$\{err\.status\}\)`\);\n\s+return null;\n\s+\}\n\s+const body = await res\.json\(\)\.catch\(\(\) => \(\{\}\)\);/);
    assert.doesNotMatch(out, /authFetch/);
});

test('mutation: json first without a fallback, or a composite ok check, is skipped', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export async function a() {
    const res = await authFetch('/api/a', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    return body;
}
export async function b() {
    const res = await authFetch('/api/b', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error('x');
    return body;
}
`;
    const sb = sandbox({ 'src/components/x/j.ts': src });
    const r = run([sb.at('src/components/x/j.ts')], { mode: 'mutation', dry: true });
    assert.equal(r.converted.length, 0);
    assert.deepEqual(r.skipped.map((s) => s.reason), ['ok check is not the first use of the Response', 'the ok check is not a plain res.ok test']);
});

test('mutation: the refused branch may read its JSON through a fallback and the status', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export async function save(set: (s: string) => void) {
    const res = await authFetch('/api/x', { method: 'PUT', body: '{}' });
    if (!res.ok) {
        const d = await res.json().catch(() => null);
        set(d?.error ?? String(res.status));
        return;
    }
}
`;
    const sb = sandbox({ 'src/components/x/save.ts': src });
    const file = sb.at('src/components/x/save.ts');
    const r = run([file], { mode: 'mutation', dry: true });
    assert.deepEqual(r.skipped, []);
    const out = r.texts[file];
    assert.match(out, /const d = errorBody\(err\) \?\? null;\n\s+set\(d\?\.error \?\? String\(err\.status\)\);/);
    assert.doesNotMatch(out, /let res/, 'the Response is not used after the check');
});

test('mutation: an else branch that reads the answer moves into the catch', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export async function create(done: () => void, fail: (s: string) => void) {
    const res = await authFetch('/api/things', { method: 'POST', body: '{}' });
    if (res.ok) {
        done();
    } else {
        const d = await res.json().catch(() => ({}));
        fail(d.error || 'x');
    }
}
`;
    const sb = sandbox({ 'src/components/x/create.ts': src });
    const file = sb.at('src/components/x/create.ts');
    const r = run([file], { mode: 'mutation', dry: true });
    assert.deepEqual(r.skipped, []);
    const out = r.texts[file];
    assert.match(out, /let res: Response \| undefined;\n\s+try \{\n\s+res = await mutate\('\/api\/things', \{ method: 'POST', body: '\{\}' \}\);/);
    assert.match(out, /\} catch \(err\) \{\n\s+if \(!\(err instanceof RefusedError\)\) throw err;\n\s+const d = errorBody\(err\) \?\? \{\};\n\s+fail\(d\.error \|\| 'x'\);\n\s+\}\n\s+if \(res\) \{\n\s+done\(\);/);
});

test('mutation: a checked GET outside an effect becomes request(); inside an effect it is left for query mode', () => {
    const src = `import { useEffect } from 'react';
import { authFetch } from '../../utils/helpers';
export async function peek(id: string): Promise<string | null> {
    const res = await authFetch('/api/things/' + id);
    if (!res.ok) return null;
    return res.text();
}
export function Hook({ id }: { id: string }) {
    useEffect(() => {
        (async () => {
            const res = await authFetch('/api/in-effect/' + id);
            if (!res.ok) return;
        })();
    }, [id]);
    return null;
}
`;
    const sb = sandbox({ 'src/components/x/peek.tsx': src });
    const file = sb.at('src/components/x/peek.tsx');
    const r = run([file], { mode: 'mutation', dry: true });
    assert.equal(r.converted.length, 1);
    assert.equal(r.converted[0].kind, 'request');
    assert.deepEqual(r.skipped.map((s) => s.reason), ['GET inside an effect (query mode)']);
    const out = r.texts[file];
    assert.match(out, /import \{ request(?:, RefusedError)? \} from '\.\.\/\.\.\/api\/mutate';/);
    assert.match(out, /let res: Response;\n\s+try \{\n\s+res = await request\('\/api\/things\/' \+ id\);/);
    assert.match(out, /const res = await authFetch\('\/api\/in-effect\/'/);
});

test('mutation: a file that already binds the imported name is skipped', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export class RefusedError extends Error {}
export async function a() {
    const res = await authFetch('/api/a', { method: 'POST' });
    if (!res.ok) throw new RefusedError('x');
}
export async function b(request: string) {
    const res = await authFetch('/api/b/' + request);
    if (!res.ok) return null;
    return res.text();
}
`;
    const sb = sandbox({ 'src/components/x/clash.ts': src });
    const r = run([sb.at('src/components/x/clash.ts')], { mode: 'mutation', dry: true });
    assert.equal(r.converted.length, 0);
    assert.deepEqual(r.skipped.map((s) => s.reason), ['the file already binds a name the conversion imports', 'the file already binds a name the conversion imports']);
});

test('mutation: a file the test setup loads is left alone (a helpers mock would not reach api/mutate)', () => {
    const src = `import { authFetch } from '../../utils/helpers';
export async function peek(id: string): Promise<string | null> {
    const res = await authFetch('/api/things/' + id);
    if (!res.ok) return null;
    return res.text();
}
`;
    const sb = sandbox({
        'src/test/setup.ts': "await import('../hooks/useThing');\n",
        'src/hooks/useThing.ts': src.replace('../../utils/helpers', '../utils/helpers'),
        'src/components/x/peek.ts': src,
    });
    const r = run([sb.at('src/hooks/useThing.ts'), sb.at('src/components/x/peek.ts')], { mode: 'mutation', dry: true });
    assert.equal(r.converted.length, 1);
    assert.match(r.converted[0].file, /components\/x\/peek\.ts$/);
    assert.deepEqual(r.skipped.map((s) => s.reason), ['loaded by the test setup (api/mutate would escape the helpers mock)']);
});

test('--max-lines: a conversion that would push a small file over the limit is dropped, a file already over may grow', () => {
    const body = (n) => `export async function f${n}(set: (s: string) => void) {
    const res = await authFetch('/api/x${n}', { method: 'POST' });
    if (!res.ok) {
        set('x');
        return;
    }
}
`;
    const head = "import { authFetch } from '../../utils/helpers';\n";
    const sb = sandbox({
        'src/components/x/near.ts': head + body(1) + '\n'.repeat(4),
        'src/components/x/over.ts': head + body(2) + '\n'.repeat(30),
    });
    const r = run([sb.at('src/components/x/near.ts'), sb.at('src/components/x/over.ts')], { mode: 'mutation', dry: true, maxLines: 13 });
    assert.deepEqual(r.converted.map((c) => path.basename(c.file)), ['over.ts']);
    assert.deepEqual(r.skipped.map((c) => c.reason), ['would push the file over 13 lines']);
    assert.equal(r.changedFiles.length, 1);
});

const LOADER = `import { useCallback, useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';

export default function Roles({ orgId }: { orgId: string }) {
    const [roles, setRoles] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await authFetch(\`\${API_BASE}/api/orgs/\${orgId}/roles\`);
            if (res.ok) setRoles(await res.json());
        } finally {
            setLoading(false);
        }
    }, [orgId]);

    useEffect(() => { load(); }, [load]);

    const add = async (name: string) => {
        await authFetch(\`\${API_BASE}/api/orgs/\${orgId}/roles\`, { method: 'POST', body: name });
        await load();
    };

    return <button onClick={() => add('x')}>{loading ? '…' : roles.join(',')}</button>;
}
`;

test('loader: a useCallback loader called by one effect becomes useQuery; other callers use refetch()', () => {
    const sb = sandbox({ 'src/components/org/Roles.tsx': LOADER });
    const file = sb.at('src/components/org/Roles.tsx');
    const r = run([file], { mode: 'query', dry: true });
    assert.deepEqual(r.skipped, []);
    assert.equal(r.converted.length, 1);
    assert.equal(r.converted[0].loader, 'load');
    const comp = r.texts[file];
    assert.doesNotMatch(comp, /useEffect|useCallback|useState|const load\b/);
    assert.match(comp, /const rolesQuery = use\w+\(orgId\);/);
    assert.match(comp, /const roles = rolesQuery\.data \?\? EMPTY_ROLES;/);
    assert.match(comp, /const loading = rolesQuery\.isFetching;/);
    assert.match(comp, /await rolesQuery\.refetch\(\);/);
    assert.doesNotMatch(comp, /await load\(\)/);
    const hook = r.texts[sb.at('src/api/queries/org.ts')];
    assert.match(hook, /useQuery<string\[\], Error>/);
    assert.match(hook, /await authFetch\(`\$\{API_BASE\}\/api\/orgs\/\$\{orgId\}\/roles`\)/);
});

test('loader: used as a value, or guarded and called from elsewhere, is skipped', () => {
    const asValue = LOADER.replace("return <button onClick={() => add('x')}>", "return <button onClick={load} onBlur={() => add('x')}>");
    const sb = sandbox({ 'src/components/org/Roles.tsx': asValue });
    const r1 = run([sb.at('src/components/org/Roles.tsx')], { mode: 'query', dry: true });
    assert.deepEqual(r1.skipped.map((s) => s.reason), ['the loader is used as a value, not only called']);
    const guarded = LOADER.replace('setLoading(true);\n        try {', 'if (!orgId) return;\n        setLoading(true);\n        try {');
    const sb2 = sandbox({ 'src/components/org/Roles.tsx': guarded });
    const r2 = run([sb2.at('src/components/org/Roles.tsx')], { mode: 'query', dry: true });
    assert.deepEqual(r2.skipped.map((s) => s.reason), ['the loader guards itself and has other callers']);
});
