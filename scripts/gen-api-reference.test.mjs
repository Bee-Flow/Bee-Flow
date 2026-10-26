import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    INDEX_REL,
    OPENAPI_REL,
    PAGES_REL,
    accessLine,
    accessPhrases,
    buildFiles,
    buildOpenApi,
    diffTree,
    esc,
    flattenSchema,
    groupOf,
    isPlainPath,
    normaliseRoutes,
    openapiPath,
    pageAssignment,
    pathParamNames,
    serializeOpenApi,
    typeOf,
    walkEnv,
    walkServer,
    writeTree,
} from './gen-api-reference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const route = (over) => ({ method: 'GET', path: '/x', gates: [], middleware: [], schemas: {}, probedHandler: false, ...over });
const AUTH = { axis: 'auth' };

test('paths: express syntax becomes OpenAPI syntax, regular expressions are not plain paths', () => {
    assert.equal(openapiPath('/a/:id/b/:sub'), '/a/{id}/b/{sub}');
    assert.equal(openapiPath('/files/{*key}'), '/files/{key}');
    assert.equal(openapiPath('/app/*rest'), '/app/{rest}');
    assert.deepEqual(pathParamNames('/a/:id/b/*rest'), ['id', 'rest']);
    assert.equal(isPlainPath('/api/x/:id'), true);
    assert.equal(isPlainPath('/api/cms/^\\/asset\\/(.+)$/'), false);
    assert.equal(isPlainPath('/^\\/blog$/'), false);
});

test('groups: /api/<x> and the first segment', () => {
    assert.equal(groupOf('/api/automation/runs/:id'), 'api/automation');
    assert.equal(groupOf('/auth/login'), 'auth');
    assert.equal(groupOf('/agents/:id'), 'agents');
    assert.equal(groupOf('/api'), 'api');
    assert.equal(groupOf('/:slug'), '');
    assert.equal(groupOf('/^\\/x$/'), '');
});

test('normaliseRoutes: sorted, ALL for _ALL, and the FIRST of a duplicate wins', () => {
    const raw = {
        routes: [
            route({ method: 'POST', path: '/b' }),
            // Public mount first, the same route again behind a gate: Express answers from the first.
            route({ method: 'GET', path: '/a', gates: [] }),
            route({ method: 'GET', path: '/a', gates: [AUTH], schemas: { query: { type: 'object' } } }),
            route({ method: '_ALL', path: '/a' }),
            route({ method: 'DELETE', path: '/a' }),
        ],
    };
    const out = normaliseRoutes(raw);
    assert.deepEqual(out.map((r) => `${r.method} ${r.path}`), ['GET /a', 'DELETE /a', 'ALL /a', 'POST /b']);
    assert.deepEqual(out[0].gates, [], 'the gated twin must not hide the public route');
    assert.deepEqual(out[0].schemas, {});
});

test('access: who first, no gate says so, MCP paths name their bearer token', () => {
    const r = route({
        gates: [
            { axis: 'capability', id: 'automations' },
            { axis: 'license', feature: 'automations' },
            { axis: 'rbac', anyOf: ['manage_agents', 'all'] },
            AUTH,
            { axis: 'module', id: 'apps' },
            { axis: 'orgStatus' },
        ],
        middleware: ['trainingGate'],
        probedHandler: true,
    });
    assert.deepEqual(accessPhrases(r), ['Signed-in user', 'Permission `manage_agents`', 'Licence feature `automations`', 'Capability `automations`']);
    assert.equal(
        accessLine(r),
        'Signed-in user · Permission `manage_agents` · Licence feature `automations` · Capability `automations` · middleware `trainingGate` · the handler also checks who the caller is',
    );
    assert.match(accessLine(route()), /^no gate in the middleware chain/);
    assert.match(accessLine(route({ path: '/mcp/cms' })), /MCP token/);
    assert.equal(accessLine(route({ gates: [{ axis: 'platform', kind: 'superAdmin' }] })), 'Platform admin');
});

test('buildOpenApi: schemas become parameters and a request body, security only where a gate asks for a session', () => {
    const doc = buildOpenApi(normaliseRoutes({
        routes: [
            route({
                method: 'POST',
                path: '/api/things/:id',
                gates: [AUTH],
                schemas: {
                    params: { type: 'object', properties: { id: { type: 'string', minLength: 3 } } },
                    query: { type: 'object', properties: { dry: { type: 'boolean' } }, required: ['dry'] },
                    body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                },
            }),
            route({ method: 'GET', path: '/api/health' }),
            route({ method: 'GET', path: '/api/cms/^\\/asset$/' }),
            route({ method: 'ALL', path: '/api/any' }),
        ],
    }));
    assert.equal(doc.openapi, '3.1.0');
    assert.deepEqual(Object.keys(doc.paths), ['/api/health', '/api/things/{id}']);
    const op = doc.paths['/api/things/{id}'].post;
    assert.deepEqual(op.parameters, [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', minLength: 3 } },
        { in: 'query', name: 'dry', required: true, schema: { type: 'boolean' } },
    ]);
    assert.equal(op.requestBody.required, true);
    assert.deepEqual(op.requestBody.content['application/json'].schema.required, ['name']);
    assert.deepEqual(op.security, [{ sessionCookie: [] }, { connectorBearer: [] }]);
    assert.equal(op['x-bf-request-schema'], true);
    const health = doc.paths['/api/health'].get;
    assert.equal(health.security, undefined, 'no gate must not read as "no authentication needed"');
    assert.equal(health['x-bf-request-schema'], false);
    assert.match(doc.info.description, /Do not edit by hand/);
});

test('buildOpenApi: operation ids are unique', () => {
    const doc = buildOpenApi(normaliseRoutes({
        routes: [route({ path: '/a-b' }), route({ path: '/a/b' }), route({ path: '/a/:x' }), route({ method: 'POST', path: '/a/b' })],
    }));
    const ids = Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId));
    assert.equal(new Set(ids).size, ids.length);
});

test('serializeOpenApi: valid JSON, one line per path, keys sorted', () => {
    const doc = buildOpenApi(normaliseRoutes({ routes: [route({ path: '/b' }), route({ path: '/a' })] }));
    const text = serializeOpenApi(doc);
    assert.deepEqual(JSON.parse(text), doc);
    const lines = text.split('\n');
    assert.ok(lines.some((l) => l.startsWith('"/a":')) && lines.some((l) => l.startsWith('"/b":')));
    assert.ok(lines.findIndex((l) => l.startsWith('"/a":')) < lines.findIndex((l) => l.startsWith('"/b":')));
    assert.ok(text.endsWith('}\n'));
});

test('schema rows: dotted names, array items, enums, constraints', () => {
    const schema = {
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string', minLength: 1, description: 'The {name} <b>' },
            mode: { enum: ['a', 'b'] },
            tags: { type: 'array', items: { type: 'string' } },
            owner: { type: 'object', properties: { id: { type: 'string' } } },
            rows: { type: 'array', items: { type: 'object', properties: { n: { type: 'number', minimum: 0 } } } },
            either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
    };
    const rows = flattenSchema(schema);
    assert.deepEqual(rows.map((r) => r.name), ['name', 'mode', 'tags', 'owner', 'owner.id', 'rows', 'rows[].n', 'either']);
    assert.equal(rows[0].required, true);
    assert.equal(typeOf(schema.properties.mode), 'one of `"a"`, `"b"`');
    assert.equal(typeOf(schema.properties.tags), 'array of string');
    assert.equal(typeOf(schema.properties.either), 'string or null');
    assert.equal(typeOf({}), 'any');
});

test('esc: nothing that MDX would read as markup or an expression survives', () => {
    const out = esc('a {b} <c> | `d` *e* _f_ [g]\n  h');
    assert.doesNotMatch(out.replace(/\\[{}<>|`*_[\]]/g, ''), /[{}<>|`*_[\]]/);
    assert.ok(!out.includes('\n'));
});

test('pages: groups under the threshold share "other"', () => {
    const routes = normaliseRoutes({
        routes: [
            ...Array.from({ length: 3 }, (_, i) => route({ path: `/api/big/${i}` })),
            route({ path: '/api/small' }),
            route({ path: '/healthz' }),
        ],
    });
    const pageOf = pageAssignment(routes, 3);
    assert.equal(pageOf.get('api/big'), 'api-big');
    assert.equal(pageOf.get('api/small'), 'other');
    assert.equal(pageOf.get('healthz'), 'other');
});

const FIXTURE = {
    routes: [
        route({ method: 'POST', path: '/api/things', gates: [AUTH], schemas: { body: { type: 'object', properties: { name: { type: 'string', description: 'Shown {as} <is>' } }, required: ['name'] } } }),
        route({ method: 'GET', path: '/api/things/:id', gates: [AUTH] }),
        route({ method: 'GET', path: '/api/health' }),
    ],
};

test('buildFiles: overview, pages and OpenAPI, all marked as generated, counts correct', () => {
    const { files, routes } = buildFiles(FIXTURE, { minRoutes: 2 });
    assert.deepEqual([...files.keys()].sort(), [OPENAPI_REL, INDEX_REL, `${PAGES_REL}/api-things.md`, `${PAGES_REL}/other.md`].sort());
    const index = files.get(INDEX_REL);
    assert.match(index, /3 in all/);
    assert.match(index, /1 of them declare a request schema/);
    assert.match(index, /\| \*\*Total\*\* \| \*\*3\*\* \| \*\*1\*\* \|/);
    for (const [rel, content] of files) {
        if (rel === OPENAPI_REL) continue;
        assert.match(content, /Do not edit by hand/, rel);
        assert.match(content, /custom_edit_url: null/, rel);
    }
    const page = files.get(`${PAGES_REL}/api-things.md`);
    assert.match(page, /### `POST \/api\/things`/);
    assert.match(page, /No request schema\./, 'a route without a schema says so');
    assert.match(page, /Shown \\\{as\\\} \\<is\\>/, 'description is escaped for MDX');
    assert.equal(routes.length, 3);
});

test('buildFiles is deterministic: the order of the walk does not matter', () => {
    const a = buildFiles(FIXTURE);
    const b = buildFiles({ routes: [...FIXTURE.routes].reverse() });
    assert.deepEqual([...a.files], [...b.files]);
});

test('diffTree / writeTree: stale, missing and stray pages are found, and writing fixes them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-api-ref-'));
    try {
        const { files } = buildFiles(FIXTURE, { minRoutes: 2 });
        assert.equal(diffTree(files, root).length, files.size, 'everything is missing in an empty tree');
        writeTree(files, root);
        assert.deepEqual(diffTree(files, root), []);

        fs.appendFileSync(path.join(root, INDEX_REL), 'hand edit');
        fs.writeFileSync(path.join(root, PAGES_REL, 'old-area.md'), 'stray');
        const problems = diffTree(files, root);
        assert.deepEqual(problems, [`out of date: ${INDEX_REL}`, `no longer generated (delete it): ${PAGES_REL}/old-area.md`]);

        writeTree(files, root);
        assert.deepEqual(diffTree(files, root), []);
        assert.equal(fs.existsSync(path.join(root, PAGES_REL, 'old-area.md')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('walkEnv: fixed values, and nothing from the caller beyond the basics', () => {
    const env = walkEnv({ PATH: '/bin', HOME: '/h', DATABASE_URL: 'postgres://secret', MASTER_ENCRYPTION_KEY: 'real', CMS_MCP_ENABLED: '0' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.DATABASE_URL, undefined);
    assert.notEqual(env.MASTER_ENCRYPTION_KEY, 'real');
    assert.equal(env.CMS_MCP_ENABLED, '1');
    assert.equal(env.NODE_ENV, 'test');
});

test('walkServer: an uninstalled server is a clear error, not a stack trace', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-api-ref-server-'));
    try {
        assert.throws(() => walkServer({ server: empty }), /server\/node_modules is missing/);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test('walkServer: a failing walk reports its stderr and a non-zero status', () => {
    const server = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-api-ref-server-'));
    fs.mkdirSync(path.join(server, 'node_modules'));
    try {
        const spawn = () => ({ status: 3, stderr: 'boom\nat somewhere' });
        assert.throws(() => walkServer({ server, spawn }), /route walk failed \(exit 3\)[\s\S]*boom/);
    } finally {
        fs.rmSync(server, { recursive: true, force: true });
    }
});

// ── The committed output and the docs that lean on it ────────────────

const readOpenApi = () => JSON.parse(fs.readFileSync(path.join(ROOT, OPENAPI_REL), 'utf8'));
const normPath = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}');

test('the committed OpenAPI file is generated, sorted and non-trivial', () => {
    const doc = readOpenApi();
    assert.equal(doc.openapi, '3.1.0');
    assert.match(doc.info.description, /Do not edit by hand/);
    const keys = Object.keys(doc.paths);
    assert.ok(keys.length > 1000, `only ${keys.length} paths`);
    assert.deepEqual(keys, [...keys].sort());
});

test('rest.md: every route in its tables is a route the server mounts', () => {
    const served = new Set();
    for (const [p, item] of Object.entries(readOpenApi().paths)) {
        for (const method of Object.keys(item)) served.add(`${method.toUpperCase()} ${normPath(p)}`);
    }
    const source = fs.readFileSync(path.join(ROOT, 'docs/docs/api/rest.md'), 'utf8');
    const missing = [];
    let rows = 0;
    for (const m of source.matchAll(/^\| ([A-Z/]+) \| `([^`]+)` \|/gm)) {
        for (const method of m[1].split('/')) {
            rows += 1;
            if (!served.has(`${method} ${normPath(m[2])}`)) missing.push(`${method} ${m[2]}`);
        }
    }
    assert.ok(rows > 100, 'the tables were not found');
    assert.deepEqual(missing, [], 'rest.md names routes that do not exist; fix the row or regenerate the reference');
});

test('rest.md and auth.md: no bearer "user JWT" for browsers, no API keys', () => {
    const rest = fs.readFileSync(path.join(ROOT, 'docs/docs/api/rest.md'), 'utf8');
    assert.doesNotMatch(rest, /user JWT|admin JWT/);
    assert.match(rest, /session cookie/);
    assert.doesNotMatch(rest, /\/api\/api-keys/);
});

// Needs server/node_modules (the walk loads the app), so it only runs where that is installed:
// ci.yml's server-checks job runs the same comparison as `npm run lint:api-reference`.
test('the committed reference matches the running app',
    { skip: !fs.existsSync(path.join(ROOT, 'server', 'node_modules')) && 'server/node_modules is not installed', timeout: 240_000 },
    () => {
        const { files } = buildFiles(walkServer());
        assert.deepEqual(diffTree(files), [], 'run `node scripts/gen-api-reference.mjs` and commit the result');
    });
