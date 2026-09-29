/**
 * Data Act export registry — the table is honest only while two things hold:
 *
 *   1. every DECLARED route is really mounted by the REAL router module at the
 *      prefix server/index.js uses (a route that moves turns this red, not the
 *      customer's export), and
 *   2. the held-count SQL is org-scoped and never reports an unknown as 0.
 *
 * The mount test requires the genuine leaf routers (routes/automation/crud.js,
 * routes/cms.js, …). They load without a database; the stores they pull in
 * connect lazily. Nothing is executed — the routers are only walked.
 *
 * Run: cd server && node --test --test-force-exit compliance/dataPortability/exportRegistry.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const registry = require('./exportRegistry');
const { isMounted } = require('./routeProbe');

const { EXPORT_KINDS, MACHINE_READABLE_FORMATS, KNOWN_FORMATS } = registry;
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const INDEX_SRC = fs.readFileSync(path.join(SERVER_ROOT, 'index.js'), 'utf8');

const GAP_KINDS = ['agents', 'knowledge_bases', 'conversations', 'ai_webpages', 'form_submissions'];

// ── Table shape ─────────────────────────────────────────────────────────────

test('every kind is unique, labelled by convention and declares every field the matrix needs', () => {
    const kinds = EXPORT_KINDS.map(k => k.kind);
    assert.equal(new Set(kinds).size, kinds.length, 'kinds are unique');
    for (const k of EXPORT_KINDS) {
        assert.match(k.kind, /^[a-z][a-z0-9_]+$/, `${k.kind}: snake_case id`);
        assert.equal(k.labelKey, `compliance.pf_kind_${k.kind}`, `${k.kind}: labelKey follows the pf_kind_ convention`);
        assert.ok(['per-item', 'bulk'].includes(k.scope), `${k.kind}: scope`);
        assert.ok(['org', 'platform'].includes(k.heldScope), `${k.kind}: heldScope`);
        assert.ok(Array.isArray(k.formats), `${k.kind}: formats[]`);
        for (const f of k.formats) assert.ok(KNOWN_FORMATS.includes(f), `${k.kind}: unknown format "${f}"`);
        assert.match(k.heldCountSql, /^SELECT\s/i, `${k.kind}: heldCountSql is a SELECT`);
        assert.match(k.heldCountSql, /::int AS c\b|::int AS c$/, `${k.kind}: heldCountSql projects an int column c`);
        if (k.route) {
            assert.match(k.route.method, /^(GET|POST)$/, `${k.kind}: method`);
            assert.match(k.route.path, /^\/(api|agents)\//, `${k.kind}: path is the public path incl. the mount prefix`);
            assert.ok(k.mount && k.mount.prefix && k.mount.module, `${k.kind}: mount info for the probe`);
            assert.ok(k.route.path.startsWith(k.mount.prefix + '/'), `${k.kind}: route path starts with its mount prefix`);
            assert.ok(k.formats.length > 0, `${k.kind}: a portable route has at least one format`);
            assert.equal(k.gapKey, null, `${k.kind}: no gap key on a covered kind`);
        } else {
            assert.deepEqual(k.formats, [], `${k.kind}: no formats without a route`);
            assert.equal(k.gapKey, `compliance.pf_gap_${k.kind}`, `${k.kind}: gapKey follows the pf_gap_ convention`);
        }
    }
});

test('the five known product gaps are declared with route: null so the coverage check fails honestly', () => {
    const missing = EXPORT_KINDS.filter(k => !k.route).map(k => k.kind).sort();
    assert.deepEqual(missing, [...GAP_KINDS].sort());
    assert.deepEqual(registry.portableKinds().filter(k => GAP_KINDS.includes(k)), []);
    // AI webpages have a PDF render — declared as render-only, never as a portable route.
    const web = registry.getKind('ai_webpages');
    assert.equal(web.route, null);
    assert.deepEqual(web.renderOnly, { method: 'POST', path: '/api/webpages/:id/export/pdf', formats: ['pdf'] });
    assert.equal(registry.getKind('nope'), null);
});

test('held-count SQL is org-scoped ($1) for every org kind; only platform kinds may omit it', () => {
    for (const k of EXPORT_KINDS) {
        if (k.heldScope === 'org') {
            assert.match(k.heldCountSql, /\$1\b/, `${k.kind}: org-scoped count must bind $1`);
            assert.match(k.heldCountSql, /organization_id = \$1|"organizationId" = \$1/, `${k.kind}: scoped on an organisation column`);
        } else {
            assert.doesNotMatch(k.heldCountSql, /\$1\b/, `${k.kind}: platform kind takes no org parameter`);
        }
    }
    assert.deepEqual(EXPORT_KINDS.filter(k => k.heldScope === 'platform').map(k => k.kind), ['cms_sites']);
});

test('machine-readable formats are the Data Act migration set; pdf/html/txt are known but not portable', () => {
    assert.deepEqual([...MACHINE_READABLE_FORMATS].sort(), ['csv', 'docx', 'json', 'md', 'ndjson', 'xlsx', 'xml', 'zip']);
    for (const f of ['pdf', 'html', 'txt']) {
        assert.ok(KNOWN_FORMATS.includes(f));
        assert.ok(!MACHINE_READABLE_FORMATS.includes(f));
    }
});

test('declaredRoutes flattens primary, extra and render-only routes with their role', () => {
    const routes = registry.declaredRoutes();
    const primary = routes.filter(r => r.role === 'primary');
    assert.equal(primary.length, EXPORT_KINDS.filter(k => k.route).length);
    assert.ok(routes.some(r => r.kind === 'notebooks' && r.role === 'extra' && r.path.endsWith('/export/pdf')));
    assert.ok(routes.some(r => r.kind === 'ai_webpages' && r.role === 'render_only'));
    for (const r of routes) assert.ok(r.mount, `${r.kind}: every declared route knows where it is mounted`);
});

// ── The honesty check: real routers, real mounts ────────────────────────────

test('the mount prefix of every declared route is what server/index.js mounts its parent at', () => {
    // Genuinely textual: server/index.js calls app.listen() unconditionally at
    // module scope and is never require()'d in a test — doing so here would
    // open a real port and a real db connection. The next test gets to
    // require the real LEAF routers and build a throwaway Express app around
    // one, exactly because those load without touching a database; index.js
    // itself has no such safe way to run.
    const seen = new Set();
    for (const r of registry.declaredRoutes()) {
        const { prefix, via, module: mod } = r.mount;
        if (seen.has(prefix + mod)) continue;
        seen.add(prefix + mod);
        const parent = via || mod;
        const re = new RegExp(`app\\.use\\('${prefix.replace(/[/]/g, '\\/')}'[^\\n]*require\\('\\./${parent.replace(/[/]/g, '\\/')}'\\)|const \\w+ = require\\('\\./${parent.replace(/[/]/g, '\\/')}'\\)`);
        assert.match(INDEX_SRC, re, `${r.kind}: server/index.js mounts ${parent} — expected at ${prefix}`);
        assert.ok(INDEX_SRC.includes(`app.use('${prefix}'`), `${r.kind}: index.js has an app.use('${prefix}', …)`);
    }
});

test('every DECLARED route is mounted by the REAL router module at its prefix', { timeout: 60_000 }, () => {
    const failures = [];
    for (const r of registry.declaredRoutes()) {
        let router;
        try {
            router = require(path.join(SERVER_ROOT, r.mount.module));
        } catch (e) {
            failures.push(`${r.kind}: could not load ${r.mount.module}: ${e.message}`);
            continue;
        }
        const app = express();
        app.use(r.mount.prefix, router);
        if (!isMounted(app, r.method, r.path)) failures.push(`${r.kind}: ${r.method} ${r.path} is NOT mounted by ${r.mount.module}`);
        // And the registry's own resolver agrees (it is what the check uses).
        const entry = registry.getKind(r.kind);
        if (!registry.resolveMounted(entry, { method: r.method, path: r.path })) failures.push(`${r.kind}: resolveMounted() disagrees for ${r.path}`);
    }
    assert.deepEqual(failures, []);
});

test('resolveMounted is false for a kind without a route, a route the module does not serve, or a missing module', () => {
    assert.equal(registry.resolveMounted(registry.getKind('agents')), false);
    assert.equal(registry.resolveMounted(registry.getKind('automations'), { method: 'DELETE', path: '/api/automation/:id/export' }), false);
    const bogus = { kind: 'x', route: { method: 'GET', path: '/api/x/y' }, mount: { prefix: '/api/x', module: 'routes/does-not-exist-anywhere' } };
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(registry.resolveMounted(bogus), false);
    } finally {
        console.warn = warn;
        registry.clearCache();
    }
});

// ── Held counts ─────────────────────────────────────────────────────────────

test('heldCounts: one combined round trip when it works, org id bound exactly once', async () => {
    const calls = [];
    const db = {
        async getOne(sql, params) {
            calls.push({ sql, params });
            const row = {};
            for (const k of EXPORT_KINDS) row[k.kind] = k.kind === 'automations' ? '3' : 0;
            return row;
        },
    };
    const { counts, errors } = await registry.heldCounts('org-1', { db });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, ['org-1']);
    assert.equal(counts.automations, 3, 'numeric strings from pg are coerced');
    assert.equal(counts.datatables, 0);
    assert.deepEqual(errors, {});
});

test('heldCounts: a missing table cannot blank the matrix — per-kind fallback, unknown is null, never 0', async () => {
    let first = true;
    const db = {
        async getOne(sql, params) {
            if (first) { first = false; throw Object.assign(new Error('relation "knowledge_bases" does not exist'), { code: '42P01' }); }
            if (/knowledge_bases/.test(sql)) throw Object.assign(new Error('missing'), { code: '42P01' });
            if (/automation_form_pages/.test(sql)) throw Object.assign(new Error('no column'), { code: '42703' });
            if (/cms_projects_index/.test(sql)) { assert.deepEqual(params, []); return { c: 2 }; }
            assert.deepEqual(params, ['org-1'], 'org kinds bind the org id');
            return { c: 5 };
        },
    };
    const { counts, errors } = await registry.heldCounts('org-1', { db });
    assert.equal(counts.knowledge_bases, null);
    assert.equal(counts.form_submissions, null);
    assert.equal(counts.cms_sites, 2);
    assert.equal(counts.automations, 5);
    assert.deepEqual(errors, { knowledge_bases: '42P01', form_submissions: '42703' });
});

test('coverageMatrix returns one row per kind in the contract shape, using the injected probe', async () => {
    const db = { async getOne() { const row = {}; for (const k of EXPORT_KINDS) row[k.kind] = 1; return row; } };
    const probed = [];
    const matrix = await registry.coverageMatrix('org-1', { db, probe: (entry, route) => { probed.push(entry.kind); return route.method === 'GET'; } });
    assert.equal(matrix.length, EXPORT_KINDS.length);
    for (const row of matrix) {
        assert.deepEqual(Object.keys(row).sort(), ['extra_routes', 'formats', 'gap_key', 'held', 'held_scope', 'kind', 'label_key', 'mounted', 'render_only', 'route', 'scope'].sort());
        assert.equal(row.held, 1);
    }
    const auto = matrix.find(r => r.kind === 'automations');
    assert.equal(auto.mounted, true);
    const sol = matrix.find(r => r.kind === 'solutions');
    assert.equal(sol.mounted, false, 'POST route → the stub probe says no');
    const agents = matrix.find(r => r.kind === 'agents');
    assert.equal(agents.mounted, false);
    assert.equal(agents.route, null);
    assert.equal(agents.gap_key, 'compliance.pf_gap_agents');
    assert.ok(!probed.includes('agents'), 'kinds without a route are never probed');
    // Rows are copies — a caller mutating the matrix cannot corrupt the table.
    auto.formats.push('xml');
    assert.deepEqual(registry.getKind('automations').formats, ['json']);
});
