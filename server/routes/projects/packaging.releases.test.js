/**
 * O4 deel D — GET /:id/package/releases.
 *
 * De route die de Versies-tab voedt. Wat hier wordt vastgepind:
 *
 *   1. EIGENAAR, EN NIET LAGER. `listReleases` autoriseert zelf niets (dat zegt
 *      zijn eigen kop), dus deze route IS de autorisatie. Een lezer zonder de
 *      eigenaarsrol op dit project krijgt geen geschiedenis — en dan wordt de
 *      store ook niet aangeroepen.
 *   2. HET ANTWOORD IS EEN ALLOW-LIST van vier velden. Geen manifest, geen
 *      `blueprintId`, geen `publishedBy`, en niets wat de store er volgend jaar
 *      bij levert.
 *   3. DE SCOPE IS HET PROJECT UIT DE URL. Nooit een id uit de body — dat is de
 *      enige manier waarop een geautoriseerd verzoek een ándere geschiedenis
 *      zou kunnen lezen.
 *   4. EEN MISLUKTE LEES IS GEEN LEGE GESCHIEDENIS. `{ releases: [] }` betekent
 *      "nooit gepubliceerd"; een store die omvalt geeft 500.
 *
 * Hermetisch: de stores en de gates zijn via require.cache vervangen — geen
 * database. Zelfde harnas als packaging.installs.test.js hiernaast.
 *
 * Run: cd server && node --test routes/projects/packaging.releases.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('../../license/middleware', {
    requireFeature: () => (req, res, next) => next(),
    featureAllowedForRequest: async () => ({ allowed: true }),
});

// De rolgate, als schakelaar. DAT hij op deze route staat pint
// routes/projects.routetable.test.js; hier gaat het om wat er ná de gate gebeurt.
const gate = { role: 'owner' };
stub('../../auth/projectAccess', {
    requireProjectRole: (minRole) => function requireProjectRoleMw(req, res, next) {
        if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
        if (!gate.role) return res.status(404).json({ error: 'Not found' });
        if (gate.role !== minRole) return res.status(403).json({ error: 'Insufficient permissions' });
        next();
    },
});

const fx = { rows: [], throws: false, calls: [], release: null, gallery: new Map() };

const project = { kind: 'solution', stage: null, installedFromBlueprintId: null, installedVersion: null };
stub('../../stores/projectStore', {
    getProject: async () => ({
        id: 'p1', organizationId: 'org_a', kind: project.kind, stage: project.stage,
        installedFromBlueprintId: project.installedFromBlueprintId, installedVersion: project.installedVersion,
    }),
});
stub('../../stores/blueprintStore', {
    listReleases: async (projectId, opts) => {
        fx.calls.push({ name: 'listReleases', projectId, opts });
        if (fx.throws) throw new Error('de geschiedenis is niet te lezen');
        return fx.rows;
    },
    getRelease: async (projectId, releaseId) => {
        fx.calls.push({ name: 'getRelease', projectId, releaseId });
        return fx.release && fx.release.id === releaseId ? fx.release : null;
    },
    getBlueprintById: async (id, opts) => {
        fx.calls.push({ name: 'getBlueprintById', id, opts });
        return fx.gallery.get(id) || null;
    },
    canRead: () => true,
    listBlueprintsFor: async () => [],
    countInstallsFor: async () => ({ here: 0, elsewhere: 0 }),
});
stub('../../projects/packaging/capture', { captureSolution: async () => ({ ok: false, errors: ['n.v.t.'] }) });
stub('../../stores/userStore', {
    getOrganization: async (id) => (id ? { id, name: 'Acme' } : null),
});

// The upgrade engine: the REAL `isNewer` (the route's not_newer rule is that
// function), and recording doubles for planning and applying.
const realUpgrade = require('../../projects/packaging/upgrade');
stub('../../projects/packaging/upgrade', {
    ...realUpgrade,
    planUpgrade: async (args) => { fx.calls.push({ name: 'planUpgrade', args }); return { ok: true, plan: { replace: [], skip: [], add: [] }, toVersion: 2 }; },
    applyUpgrade: async (args) => { fx.calls.push({ name: 'applyUpgrade', args }); return { ok: true, toVersion: 2, report: { warnings: [] } }; },
});

const router = require('./packaging');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

let server;
let base;
let session = null;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = session ? { user: session } : {}; next(); });
    app.use('/api/projects', router);
    app.use(terminalErrorHandler);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

async function releases(projectId, user) {
    session = user === undefined ? { id: 'alice', organizationId: 'org_a' } : user;
    fx.calls.length = 0;
    const res = await new Promise((resolve, reject) => {
        http.get(`${base}/api/projects/${projectId}/package/releases`, (r) => {
            let body = '';
            r.on('data', c => { body += c; });
            r.on('end', () => resolve({ status: r.statusCode, body }));
        }).on('error', reject);
    });
    let json = null;
    try { json = JSON.parse(res.body); } catch { /* niet-JSON is zelf het antwoord */ }
    return { status: res.status, json };
}

function reset() {
    gate.role = 'owner';
    project.kind = 'solution';
    project.stage = null;
    project.installedFromBlueprintId = null;
    project.installedVersion = null;
    fx.release = null;
    fx.gallery = new Map();
    fx.throws = false;
    fx.rows = [{
        id: 'rel_1',
        version: 3,
        notes: { entities: [{ kind: 'app', entityId: 'app_1', name: 'Desk', change: 'changed', text: null }], omitted: 0, textsDropped: false },
        publishedAt: '2026-09-05T09:00:00Z',
    }];
    fx.calls.length = 0;
}

// ── 1. Eigenaar, en niet lager ──────────────────────────────────────────────

test('de eigenaar krijgt de geschiedenis', async () => {
    reset();
    const res = await releases('p1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.releases.length, 1);
    assert.strictEqual(res.json.releases[0].version, 3);
});

test('een editor of een vreemde leest hem niet, en de store wordt niet aangeroepen', async () => {
    reset();
    gate.role = 'editor';
    assert.strictEqual((await releases('p1')).status, 403);
    assert.deepStrictEqual(fx.calls, []);

    reset();
    gate.role = null;
    assert.strictEqual((await releases('p1')).status, 404);
    assert.deepStrictEqual(fx.calls, [], 'listReleases autoriseert niets; hij mag dus niet draaien');
});

test('zonder sessie gebeurt er niets', async () => {
    reset();
    assert.strictEqual((await releases('p1', null)).status, 401);
    assert.deepStrictEqual(fx.calls, []);
});

// ── 2. Een allow-list, geen doorgegeven rij ─────────────────────────────────

test('HET ANTWOORD DRAAGT VIER VELDEN — geen manifest, geen publishedBy', async () => {
    reset();
    // De store levert hier bewust een RIJKERE rij dan de route nodig heeft. Een
    // payload uit een allow-list trekt zich daar niets van aan; een payload waar
    // sleutels van zijn afgehaald wel.
    fx.rows = [{
        id: 'rel_1', version: 3, notes: { entities: [] }, publishedAt: '2026-09-05T09:00:00Z',
        projectId: 'p1', blueprintId: 'bp_geheim', publishedBy: 'u_alice',
        manifest: { solution: { name: 'Onboarding' } },
        kolomVanVolgendJaar: 'lekt-niet',
    }];
    const res = await releases('p1');
    assert.deepStrictEqual(Object.keys(res.json.releases[0]).sort(), ['id', 'notes', 'publishedAt', 'version']);
    const asText = JSON.stringify(res.json);
    for (const leak of ['bp_geheim', 'u_alice', 'Onboarding', 'lekt-niet']) {
        assert.ok(!asText.includes(leak), `${leak} hoort niet in een releaselijst`);
    }
});

test('de notitie reist WEL mee — dat is de hele inhoud van de Versies-tab', async () => {
    reset();
    const res = await releases('p1');
    const note = res.json.releases[0].notes;
    assert.strictEqual(note.entities[0].change, 'changed');
    // `text: null` op een gewijzigde rij betekent "geen woorden", niet "geen
    // nieuws". De route mag die null niet wegpoetsen.
    assert.strictEqual(note.entities[0].text, null);
});

// ── 3. De scope is het project uit de URL ───────────────────────────────────

test('de geschiedenis wordt op het project uit de URL opgevraagd', async () => {
    reset();
    await releases('p_uit_de_url');
    assert.strictEqual(fx.calls[0].projectId, 'p_uit_de_url');
});

// ── 4. Een mislukte lees is geen lege geschiedenis ──────────────────────────

test('EEN OMGEVALLEN STORE GEEFT 500, NOOIT EEN LEGE LIJST', async () => {
    reset();
    fx.throws = true;
    const res = await releases('p1');
    assert.strictEqual(res.status, 500);
    assert.ok(!res.json?.releases, '{ releases: [] } zou lezen als "nooit gepubliceerd"');
});

test('een project dat nooit gepubliceerd is, antwoordt met een lege lijst', async () => {
    reset();
    fx.rows = [];
    const res = await releases('p1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { releases: [] });
});

// ── Packaging is for Studio Solutions ──────────────────────────────────────

test('a collaborative project has no release history: 404, and the store is not read', async () => {
    reset();
    project.kind = 'workspace';
    const res = await releases('p1');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(fx.calls, []);
});

test('a legacy (unclassified) project still has its history', async () => {
    reset();
    project.kind = null;
    const res = await releases('p1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.releases.length, 1);
});

// ── A Solution stage has no history of its own here ────────────────────────

test('a Solution stage (UAT/Production) answers 404, and the store is not read', async () => {
    reset();
    project.stage = 'uat';
    const res = await releases('p1');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(fx.calls, []);
});

// ── GET /:id/package/releases/:releaseId ───────────────────────────────────

function get(path) {
    session = { id: 'alice', organizationId: 'org_a' };
    fx.calls.length = 0;
    return new Promise((resolve, reject) => {
        http.get(`${base}${path}`, (r) => {
            let body = '';
            r.on('data', c => { body += c; });
            r.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch { /* not JSON */ }
                resolve({ status: r.statusCode, headers: r.headers, body, json });
            });
        }).on('error', reject);
    });
}

const galleryRelease = (over = {}) => ({
    id: 'rel_7', projectId: 'p1', blueprintId: 'bp_secret', version: 4, channel: 'gallery',
    notes: { entities: [] }, publishedAt: '2026-09-05T09:00:00Z', publishedBy: 'u_alice',
    manifest: { format: 'beeflow.blueprint', solution: { key: 'sol_p1', version: 4, name: 'Onboarding Desk' } },
    ...over,
});

test('one release comes back with its manifest, through an allow-list, scoped on the URL project', async () => {
    reset();
    fx.release = galleryRelease();
    const res = await get('/api/projects/p1/package/releases/rel_7');
    assert.strictEqual(res.status, 200, res.body);
    assert.deepStrictEqual(Object.keys(res.json.release).sort(), ['id', 'manifest', 'notes', 'publishedAt', 'version']);
    assert.strictEqual(res.json.release.manifest.solution.key, 'sol_p1');
    assert.ok(!res.body.includes('u_alice') && !res.body.includes('bp_secret'));
    assert.deepStrictEqual(fx.calls.find(c => c.name === 'getRelease'), { name: 'getRelease', projectId: 'p1', releaseId: 'rel_7' });
});

test('?download=1 hands the manifest over as a Blueprint file', async () => {
    reset();
    fx.release = galleryRelease();
    const res = await get('/api/projects/p1/package/releases/rel_7?download=1');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-disposition'], /attachment; filename="onboarding-desk-v4\.blueprint\.json"/);
    // The stored manifest, plus the provenance block the export route stamps:
    // without `source.blueprintId` an install from this file is tied to no
    // gallery row, and its later upgrades skip the different_solution check.
    assert.deepStrictEqual(res.json, {
        ...fx.release.manifest,
        source: { blueprintId: 'bp_secret', orgId: 'org_a', orgName: 'Acme', version: 4 },
    });
});

test('a pipeline release answers 404, also as a download: it never leaves the instance', async () => {
    reset();
    fx.release = galleryRelease({ channel: 'pipeline', blueprintId: null });
    for (const q of ['', '?download=1']) {
        const res = await get(`/api/projects/p1/package/releases/rel_7${q}`);
        assert.strictEqual(res.status, 404, q);
        assert.ok(!res.body.includes('sol_p1'), 'no manifest of a pipeline release leaves the server');
    }
});

test('an unknown release answers 404; a non-owner never reaches the store', async () => {
    reset();
    assert.strictEqual((await get('/api/projects/p1/package/releases/rel_nope')).status, 404);
    reset();
    gate.role = 'editor';
    fx.release = galleryRelease();
    const res = await get('/api/projects/p1/package/releases/rel_7');
    assert.strictEqual(res.status, 403);
    assert.ok(!fx.calls.some(c => c.name === 'getRelease'));
});

test('a misspelled query key is refused', async () => {
    reset();
    fx.release = galleryRelease();
    assert.strictEqual((await get('/api/projects/p1/package/releases/rel_7?dowload=1')).status, 400);
});

// ── Upgrade: same Solution, newer version ──────────────────────────────────

function post(path, body) {
    session = { id: 'alice', organizationId: 'org_a' };
    fx.calls.length = 0;
    const payload = JSON.stringify(body || {});
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (r) => {
            let text = '';
            r.on('data', c => { text += c; });
            r.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: r.statusCode, json });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

// A real gallery manifest, so it passes the same sanitizeManifest the
// upgrade engine runs before any source or version check.
const { buildManifest } = require('../../projects/packaging/manifest');
const manifestFor = (key, version, extra = {}) => buildManifest({ project: { id: 'p1', name: 'Desk' }, key, version, ...extra });
const engineCalls = () => fx.calls.filter(c => c.name === 'planUpgrade' || c.name === 'applyUpgrade');

for (const route of ['/api/projects/p1/package/upgrade/plan', '/api/projects/p1/package/upgrade']) {
    test(`${route}: a Blueprint of another Solution is refused 409 different_solution`, async () => {
        reset();
        project.installedFromBlueprintId = 'bp_src';
        project.installedVersion = 1;
        fx.gallery.set('bp_src', { id: 'bp_src', solutionKey: 'sol_original' });
        const res = await post(route, { manifest: manifestFor('sol_other', 2) });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.json.code, 'different_solution');
        assert.deepStrictEqual(engineCalls(), []);
        // The source row is read for its key only, never its manifest.
        assert.deepStrictEqual(fx.calls.find(c => c.name === 'getBlueprintById').opts, { includeManifest: false });
    });

    test(`${route}: the same or an older version is refused 409 not_newer`, async () => {
        reset();
        project.installedFromBlueprintId = 'bp_src';
        project.installedVersion = 3;
        fx.gallery.set('bp_src', { id: 'bp_src', solutionKey: 'sol_original' });
        for (const version of [3, 2]) {
            const res = await post(route, { manifest: manifestFor('sol_original', version) });
            assert.strictEqual(res.status, 409, `version ${version}`);
            assert.strictEqual(res.json.code, 'not_newer');
            assert.deepStrictEqual(res.json.details, { installedVersion: 3, blueprintVersion: version });
        }
        assert.deepStrictEqual(engineCalls(), []);
    });

    test(`${route}: a newer version of the same Solution goes through, without a warning`, async () => {
        reset();
        project.installedFromBlueprintId = 'bp_src';
        project.installedVersion = 1;
        fx.gallery.set('bp_src', { id: 'bp_src', solutionKey: 'sol_original' });
        const res = await post(route, { manifest: manifestFor('sol_original', 2) });
        assert.strictEqual(res.status, 200, JSON.stringify(res.json));
        assert.strictEqual(engineCalls().length, 1);
        assert.ok(!res.json.warnings, 'a verified source carries no warning');
    });

    test(`${route}: with the source Blueprint gone it proceeds, warning source_unverified`, async () => {
        reset();
        project.installedFromBlueprintId = 'bp_deleted';
        project.installedVersion = 1;
        const res = await post(route, { manifest: manifestFor('sol_anything', 2) });
        assert.strictEqual(res.status, 200, JSON.stringify(res.json));
        assert.deepStrictEqual(res.json.warnings, ['source_unverified']);
        assert.strictEqual(engineCalls().length, 1);
    });

    test(`${route}: a pipeline release is refused as a source (400 pipeline_release)`, async () => {
        reset();
        const res = await post(route, { manifest: { ...manifestFor('sol_p1', 9), channel: 'pipeline' } });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.json.code, 'pipeline_release');
        assert.deepStrictEqual(engineCalls(), []);
    });

    test(`${route}: a manifest a pipeline capture built (solution.slots) is refused 400 pipeline_release`, async () => {
        reset();
        const res = await post(route, { manifest: manifestFor('sol_p1', 9, { slots: [] }) });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.json.code, 'pipeline_release');
        assert.deepStrictEqual(engineCalls(), []);
    });

    test(`${route}: a file that is no Blueprint is a 400 that says so, not a 409`, async () => {
        reset();
        project.installedFromBlueprintId = 'bp_src';
        project.installedVersion = 1;
        fx.gallery.set('bp_src', { id: 'bp_src', solutionKey: 'sol_original' });
        const noSolution = { ...manifestFor('sol_original', 2) };
        delete noSolution.solution;
        for (const manifest of [noSolution, { ...manifestFor('sol_original', 2), format: 'something.else' }]) {
            const res = await post(route, { manifest });
            assert.strictEqual(res.status, 400, JSON.stringify(res.json));
            assert.strictEqual(res.json.code, 'invalid_blueprint');
        }
        // Without a source row the version check would have said not_newer.
        reset();
        project.installedFromBlueprintId = null;
        const res = await post(route, { manifest: noSolution });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.json.code, 'invalid_blueprint');
        assert.deepStrictEqual(engineCalls(), []);
    });

    test(`${route}: a Solution stage answers 404`, async () => {
        reset();
        project.stage = 'prd';
        const res = await post(route, { manifest: manifestFor('sol_p1', 2) });
        assert.strictEqual(res.status, 404);
        assert.deepStrictEqual(engineCalls(), []);
    });
}

test('install refuses a pipeline release as its source (400 pipeline_release)', async () => {
    reset();
    const res = await post('/api/projects/package/install', { manifest: { ...manifestFor('sol_p1', 9), channel: 'pipeline' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.code, 'pipeline_release');
});

test('install refuses a manifest a pipeline capture built (solution.slots / variables)', async () => {
    for (const extra of [{ slots: [] }, { variables: [] }]) {
        reset();
        const res = await post('/api/projects/package/install', { manifest: manifestFor('sol_p1', 9, extra) });
        assert.strictEqual(res.status, 400, JSON.stringify(extra));
        assert.strictEqual(res.json.code, 'pipeline_release');
    }
});
