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

const fx = { rows: [], throws: false, calls: [] };

stub('../../stores/projectStore', { getProject: async () => ({ id: 'p1', organizationId: 'org_a' }) });
stub('../../stores/blueprintStore', {
    listReleases: async (projectId, opts) => {
        fx.calls.push({ name: 'listReleases', projectId, opts });
        if (fx.throws) throw new Error('de geschiedenis is niet te lezen');
        return fx.rows;
    },
    listBlueprintsFor: async () => [],
    countInstallsFor: async () => ({ here: 0, elsewhere: 0 }),
});
stub('../../projects/packaging/capture', { captureSolution: async () => ({ ok: false, errors: ['n.v.t.'] }) });

const router = require('./packaging');

let server;
let base;
let session = null;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = session ? { user: session } : {}; next(); });
    app.use('/api/projects', router);
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
