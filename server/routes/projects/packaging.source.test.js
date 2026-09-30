/**
 * O4 deel C — wat een geëxporteerd Blueprint-bestand over zijn herkomst zegt.
 *
 * Zonder dit blok kan een BESTANDSinstallatie zichzelf nooit aan zijn Blueprint
 * koppelen, en telt zij dus nooit mee in "hoe vaak is dit geïnstalleerd". Dat
 * maakt het stempelen de voorkant van de hele installatietelling.
 *
 * Wat hier wordt vastgepind:
 *
 *   1. HET BLOK WORDT NA DE PUBLICATIE GESTEMPELD, met het echte Blueprint-id
 *      en het echte versienummer. Vóór de publicatie bestaan die niet.
 *   2. EEN EXPORT ZONDER PUBLICATIE CLAIMT GEEN BLUEPRINT. `blueprintId: null`
 *      is de eerlijke waarde: het bestand hoort bij geen enkele galerijrij.
 *   3. DE ORGANISATIENAAM IS BELEEFDHEID, GEEN DRAGEND VELD. Is zij niet te
 *      lezen, dan blijft zij null en gaat de export gewoon door.
 *   4. HET IS DE ORGANISATIE VAN HET PROJECT, niet die van de sessie: een
 *      exporterende gast schrijft niet zijn eigen org in andermans bestand.
 *
 * Hermetisch: capture, de stores en de gates zijn via require.cache vervangen.
 *
 * Run: cd server && node --test routes/projects/packaging.source.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── De stubs, vóór de router wordt geladen ──────────────────────────────────

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('../../license/middleware', {
    requireFeature: () => (req, res, next) => next(),
    featureAllowedForRequest: async () => ({ allowed: true }),
});
stub('../../auth/projectAccess', {
    // De rolgate is elders getoetst (routes/projects.routetable.test.js pint dat
    // hij op deze route staat); hier gaat het om wat er ná de gate gebeurt.
    requireProjectRole: () => (req, res, next) => next(),
});

const fx = {
    project: null,
    published: null,
    publishThrows: null,
    orgName: 'Acme',
    orgNameThrows: false,
};

stub('../../stores/projectStore', {
    getProject: async () => fx.project,
});
stub('../../projects/packaging/capture', {
    captureSolution: async () => ({
        ok: true,
        manifest: require('../../projects/packaging/manifest').buildManifest({
            project: fx.project, exportedAt: '2026-09-08T00:00:00Z',
        }),
    }),
});
stub('../../stores/blueprintStore', {
    publishRelease: async () => {
        if (fx.publishThrows) throw fx.publishThrows;
        return fx.published;
    },
});
stub('../../stores/userStore', {
    getOrganization: async (id) => {
        if (fx.orgNameThrows) throw new Error('organisatie onbereikbaar');
        return id ? { id, name: fx.orgName } : null;
    },
});

const router = require('./packaging');

// ── Het testserver-tje ──────────────────────────────────────────────────────

let server;
let base;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { id: 'alice', organizationId: 'org_session' } }; next(); });
    app.use('/api/projects', router);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

function exportProject(body) {
    const payload = JSON.stringify(body || {});
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/projects/p1/package/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (r) => {
            let text = '';
            r.on('data', c => { text += c; });
            r.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* niet-JSON is zelf het antwoord */ }
                resolve({ status: r.statusCode, json });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function reset() {
    fx.project = { id: 'p1', name: 'Onboarding', organizationId: 'org_project' };
    fx.published = null;
    fx.publishThrows = null;
    fx.orgName = 'Acme';
    fx.orgNameThrows = false;
}

const publishedAs = (id, version) => ({
    blueprint: {
        id, version, name: 'Onboarding',
        manifest: require('../../projects/packaging/manifest').buildManifest({
            project: fx.project, version,
        }),
    },
    release: { id: 'rel_1', version },
});

// ── 1. Na de publicatie ─────────────────────────────────────────────────────

test('een gepubliceerd bestand draagt het echte Blueprint-id en versienummer', async () => {
    reset();
    fx.published = publishedAs('bp_abc', 3);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.source, {
        blueprintId: 'bp_abc', orgId: 'org_project', orgName: 'Acme', version: 3,
    });
    // De bestaande annotaties blijven staan — het herkomstblok komt erbij, het
    // vervangt niets.
    assert.strictEqual(res.json._savedAs, 'bp_abc');
    assert.strictEqual(res.json._version, 3);
});

// ── 2. Zonder publicatie ────────────────────────────────────────────────────

test('een gewone download claimt geen Blueprint', async () => {
    reset();
    const res = await exportProject({});
    assert.strictEqual(res.json.source.blueprintId, null,
        'dit bestand hoort bij geen enkele galerijrij en mag daar niet naar wijzen');
    assert.strictEqual(res.json.source.orgId, 'org_project');
    assert.strictEqual(res.json.source.version, 1);
});

test('mislukt de publicatie, dan gaat het bestand mee zonder Blueprint-id', async () => {
    reset();
    fx.publishThrows = new Error('de galerij zit vol');
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.match(res.json._saveError, /galerij zit vol/);
    // Het foutpad stempelt bewust geen herkomst: er IS geen galerijrij, dus een
    // id noemen zou een verwijzing naar niets zijn.
    assert.ok(!res.json.source?.blueprintId, 'geen id van een publicatie die niet gebeurd is');
});

// ── 3. De naam is beleefdheid ───────────────────────────────────────────────

test('een onleesbare organisatienaam laat de export gewoon doorgaan', async () => {
    reset();
    fx.orgNameThrows = true;
    fx.published = publishedAs('bp_abc', 1);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.source.orgName, null);
    assert.strictEqual(res.json.source.orgId, 'org_project', 'het id staat los van de naam');
});

test('een project zonder organisatie noemt er geen', async () => {
    reset();
    fx.project = { id: 'p1', name: 'Onboarding', organizationId: null };
    const res = await exportProject({});
    assert.strictEqual(res.json.source.orgId, null);
    assert.strictEqual(res.json.source.orgName, null);
});

// ── 4. De org van het PROJECT ───────────────────────────────────────────────

test('het is de organisatie van het project, niet die van de sessie', async () => {
    // De sessie draagt org_session; de Blueprint komt uit een project in
    // org_project. Zou de sessie winnen, dan schreef een gast zijn eigen
    // organisatie in andermans bestand.
    reset();
    const res = await exportProject({});
    assert.strictEqual(res.json.source.orgId, 'org_project');
});

// ── Packaging is for Studio Solutions ──────────────────────────────────────

test('a collaborative project cannot be exported as a Blueprint: 404, nothing published', async () => {
    reset();
    fx.project = { ...fx.project, kind: 'workspace' };
    fx.published = publishedAs('bp_should_not_exist', 1);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, 'Not found');
    assert.ok(!('solution' in res.json), 'no manifest of a collaborative project leaves the server');
});

test('a Solution exports as before', async () => {
    reset();
    fx.project = { ...fx.project, kind: 'solution' };
    const res = await exportProject({});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.solution.key, 'sol_p1');
});
