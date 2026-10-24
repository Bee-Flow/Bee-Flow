import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './rq-codemod.mjs';

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

test('mutation: a res.ok branch becomes mutate() with a catch of ApiError', () => {
    const sb = sandbox({ 'src/components/things/Rename.tsx': MUTATION });
    const file = sb.at('src/components/things/Rename.tsx');
    const r = run([file], { mode: 'mutation', dry: true });
    assert.deepEqual(r.skipped, []);
    assert.equal(r.converted.length, 1);
    const out = r.texts[file];
    assert.match(out, /import \{ API_BASE \} from '\.\.\/\.\.\/utils\/helpers';/);
    assert.match(out, /import \{ mutate, ApiError \} from '\.\.\/\.\.\/api\/mutate';/);
    assert.match(out, /\n( +)let res: Response;\n\1try \{\n\1    res = await mutate/);
    assert.match(out, /\n( +)\} catch \(err\) \{\n\1    if \(!\(err instanceof ApiError\)\) throw err;\n\1    setError/);
    assert.match(out, /let res: Response;\n\s+try \{\n\s+res = await mutate\(`\$\{API_BASE\}\/api\/things\/\$\{id\}`, \{/);
    assert.match(out, /\} catch \(err\) \{\n\s+if \(!\(err instanceof ApiError\)\) throw err;\n\s+setError\(`Failed \(\$\{err\.status\}\)`\);\n\s+return;\n\s+\}/);
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
        'non-ok branch reads the Response',
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
