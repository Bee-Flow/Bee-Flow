/**
 * O4 deel C — GET /:id/package/installs.
 *
 * Blueprints zijn strikt org-gescoopt. Deze route is de ENIGE die daaroverheen
 * kijkt — zij telt installaties in de hele instantie — en dus de enige plek
 * waar dat mis kan gaan. Wat hier wordt vastgepind:
 *
 *   1. ALLEEN DE BRON. De eigenaarsrol op het BRONPROJECT is de gate; wie hier
 *      binnenkomt is per definitie iemand uit de organisatie die de Blueprint
 *      gemaakt heeft. En WELKE Blueprints meetellen komt uit `listBlueprintsFor`
 *      — de ene org-scoping-query van de store — zodat er geen tweede lezing is
 *      die het met de galerijlijst oneens kan raken.
 *   2. ER KOMEN ALLEEN GETALLEN UIT. Het antwoord heeft precies twee sleutels,
 *      opgebouwd uit een allow-list. Geen projectnaam, geen eigenaar, geen
 *      organisatie, geen tijdstip — ook niet als de stores er meer bij leveren.
 *   3. HET TELT OVER ORGANISATIES HEEN, met de organisatie van het BRONPROJECT
 *      als "hier". Niet die van de sessie: de vraag gaat over waar de Oplossing
 *      thuishoort, niet over wie er toevallig kijkt.
 *   4. NUL IS EEN ANTWOORD, ONLEESBAAR IS ER GEEN. `0` en `null` zijn
 *      verschillende antwoorden en blijven dat — het scherm besluit er iets
 *      anders op.
 *
 * Hermetisch: de stores en de gates zijn via require.cache vervangen, dus er
 * komt geen database aan te pas. De verzoeken lopen over echte HTTP tegen
 * express app.listen(0), zoals routes/studio/attention.test.js.
 *
 * Run: cd server && node --test routes/projects/packaging.installs.test.js
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

const fx = {
    project: null,
    blueprints: [],
    releases: [],
    listThrows: false,
    releasesThrow: false,
    counted: { here: 0, elsewhere: 0 },
    calls: [],
};

stub('../../stores/projectStore', {
    getProject: async (id) => { fx.calls.push({ name: 'getProject', id }); return fx.project; },
});
stub('../../stores/blueprintStore', {
    listBlueprintsFor: async (args) => {
        fx.calls.push({ name: 'listBlueprintsFor', args });
        if (fx.listThrows) throw new Error('de galerij is niet te lezen');
        return fx.blueprints;
    },
    listReleases: async (projectId) => {
        fx.calls.push({ name: 'listReleases', projectId });
        if (fx.releasesThrow) throw new Error('de geschiedenis is niet te lezen');
        return fx.releases;
    },
    countInstallsFor: async (ids, opts) => {
        fx.calls.push({ name: 'countInstallsFor', ids, opts });
        return fx.counted;
    },
});
stub('../../projects/packaging/capture', { captureSolution: async () => ({ ok: false, errors: ['n.v.t.'] }) });

const router = require('./packaging');

// ── Het testserver-tje ──────────────────────────────────────────────────────

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

async function installs(projectId, user) {
    session = user === undefined ? { id: 'alice', organizationId: 'org_source' } : user;
    fx.calls.length = 0;
    const res = await new Promise((resolve, reject) => {
        http.get(`${base}/api/projects/${projectId}/package/installs`, (r) => {
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
    fx.project = { id: 'p1', name: 'Onboarding', organizationId: 'org_source' };
    fx.blueprints = [
        { id: 'bp_mine', solutionKey: 'sol_p1', createdBy: 'alice', version: 3 },
        { id: 'bp_colleague', solutionKey: 'sol_p1', createdBy: 'bob', version: 1 },
        { id: 'bp_other_project', solutionKey: 'sol_p9', createdBy: 'alice', version: 1 },
    ];
    fx.releases = [];
    fx.listThrows = false;
    fx.releasesThrow = false;
    fx.counted = { here: 2, elsewhere: 5 };
    fx.calls.length = 0;
}

const call = (name) => fx.calls.find(c => c.name === name);

// ── 1. Alleen de bron ───────────────────────────────────────────────────────

test('de eigenaar van het bronproject krijgt de twee getallen', async () => {
    reset();
    const res = await installs('p1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { installsHere: 2, installsElsewhere: 5 });
});

test('wie het bronproject niet bezit, telt niet', async () => {
    reset();
    gate.role = 'editor';
    const denied = await installs('p1');
    assert.strictEqual(denied.status, 403);

    reset();
    gate.role = null;                    // geen rol op dit project → 404
    const stranger = await installs('p1');
    assert.strictEqual(stranger.status, 404);
    assert.ok(!call('countInstallsFor'), 'een geweigerde lezer laat de telling niet draaien');
});

test('zonder sessie is er niets te tellen', async () => {
    reset();
    const res = await installs('p1', null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(fx.calls, [], 'geen enkele storelezing zonder ingelogde gebruiker');
});

test('welke Blueprints meetellen komt uit de org-gescoopte galerijlijst', async () => {
    // Niet uit een eigen tweede lezing: de lijst en de telling moeten het over
    // "welke Blueprints zijn van deze lezer" eens zijn, en dat is precies de
    // wond die de kop van canRead beschrijft.
    reset();
    await installs('p1');
    const listed = call('listBlueprintsFor');
    assert.deepStrictEqual(listed.args, { userId: 'alice', organizationId: 'org_source' });

    // Alleen de Blueprints van DIT project, van alle makers — twee collega's
    // die hetzelfde project publiceren hebben elk hun eigen serie, en beide
    // installaties tellen mee.
    assert.deepStrictEqual(call('countInstallsFor').ids, ['bp_mine', 'bp_colleague']);
});

test('een Blueprint die de lezer niet in zijn galerij ziet, telt hij hier ook niet', async () => {
    reset();
    fx.blueprints = [];                  // de org-scoping liet niets over
    const res = await installs('p1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(call('countInstallsFor').ids, []);
});

test('een VERWIJDERDE galerijrij telt nog steeds mee via de eigen geschiedenis', async () => {
    // Anders leest het scherm "niemand heeft dit geïnstalleerd" zodra de maker
    // zijn Blueprint weggooit — terwijl de projecten die eruit komen gewoon
    // blijven bestaan mét hun installed_from_blueprint_id. Dat is het antwoord
    // waarop iemand besluit een Oplossing weg te gooien.
    reset();
    fx.blueprints = [];
    fx.releases = [
        { id: 'rel_3', version: 3, blueprintId: 'bp_weg' },
        { id: 'rel_2', version: 2, blueprintId: 'bp_weg' },
    ];
    const res = await installs('p1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(call('listReleases').projectId, 'p1',
        'de geschiedenis wordt op precies het geautoriseerde project gescoopt');
    assert.deepStrictEqual(call('countInstallsFor').ids, ['bp_weg'],
        'één id, niet twee: dezelfde Blueprint in twee release-rijen is één Blueprint');
});

test('galerij en geschiedenis worden samengevoegd, zonder dubbels', async () => {
    reset();
    fx.releases = [
        { id: 'rel_9', version: 9, blueprintId: 'bp_mine' },      // staat al in de galerij
        { id: 'rel_1', version: 1, blueprintId: 'bp_ouder' },     // van een verwijderde rij
        { id: 'rel_0', version: 1, blueprintId: null },           // onbruikbaar, telt niet
    ];
    await installs('p1');
    assert.deepStrictEqual(call('countInstallsFor').ids, ['bp_mine', 'bp_colleague', 'bp_ouder']);
});

test('een onleesbare geschiedenis is geen nul installaties', async () => {
    reset();
    fx.releasesThrow = true;
    const res = await installs('p1');
    assert.strictEqual(res.status, 500,
        'onbekend versmalt: het scherm zegt "niet te lezen", nooit "nul"');
    assert.ok(!call('countInstallsFor'), 'er wordt niet geteld op een half opgehaalde lijst');
});

// ── 2. Er komen alleen getallen uit ─────────────────────────────────────────

test('het antwoord heeft precies twee sleutels, en geen projectdetail', async () => {
    reset();
    // De stores leveren hier bewust RIJKERE objecten dan de route nodig heeft:
    // een payload uit een allow-list trekt zich daar niets van aan, een payload
    // waar sleutels van zijn afgehaald wel.
    fx.project = {
        id: 'p1', name: 'Onboarding', organizationId: 'org_source',
        ownerId: 'alice', icon: '📁', installedFromOrgId: 'org_geheim',
    };
    fx.blueprints = [{ id: 'bp_mine', solutionKey: 'sol_p1', name: 'Orders', createdBy: 'alice' }];
    fx.counted = { here: 1, elsewhere: 0, byOrganization: { org_klant: 1 } };

    const res = await installs('p1');
    assert.deepStrictEqual(Object.keys(res.json).sort(), ['installsElsewhere', 'installsHere']);
    const asText = JSON.stringify(res.json);
    for (const leak of ['Onboarding', 'alice', 'org_source', 'org_klant', 'bp_mine', 'Orders', '📁']) {
        assert.ok(!asText.includes(leak), `${leak} hoort niet in een installatietelling`);
    }
});

// ── 3. Over organisaties heen, met de bron als "hier" ───────────────────────

test('"hier" is de organisatie van het bronproject, niet die van de sessie', async () => {
    reset();
    session = { id: 'alice', organizationId: 'org_sessie' };
    await installs('p1', { id: 'alice', organizationId: 'org_sessie' });
    assert.deepStrictEqual(call('countInstallsFor').opts, { organizationId: 'org_source' });
});

test('een project zonder organisatie telt met "geen organisatie" als hier', async () => {
    reset();
    fx.project = { id: 'p1', name: 'Persoonlijk', organizationId: null };
    await installs('p1');
    assert.deepStrictEqual(call('countInstallsFor').opts, { organizationId: null });
});

// ── 4. Nul is een antwoord, onleesbaar is er geen ───────────────────────────

test('nul en onleesbaar zijn verschillende antwoorden', async () => {
    reset();
    fx.counted = { here: 0, elsewhere: 0 };
    const zero = await installs('p1');
    assert.deepStrictEqual(zero.json, { installsHere: 0, installsElsewhere: 0 });

    reset();
    fx.counted = null;                   // de store kon het niet nakijken
    const unknown = await installs('p1');
    assert.strictEqual(unknown.status, 200);
    assert.deepStrictEqual(unknown.json, { installsHere: null, installsElsewhere: null },
        'null blijft null: het scherm moet "onbekend" kunnen tonen in plaats van "geen"');
});

test('een onleesbare galerij is geen nul installaties', async () => {
    reset();
    fx.listThrows = true;
    const res = await installs('p1');
    assert.strictEqual(res.status, 500,
        'de client leest dit als onleesbaar; 200 met nullen zou hier ook mogen, 0 nooit');
    assert.ok(!call('countInstallsFor'), 'er wordt niet geteld op een lijst die er niet is');
});

test('een project dat niet gelezen kan worden telt niets', async () => {
    reset();
    fx.project = null;
    const res = await installs('p1');
    assert.strictEqual(res.status, 404);
    assert.ok(!call('countInstallsFor'));
});

// ── Packaging is for Studio Solutions ──────────────────────────────────────

test('a collaborative project has no installs to count: 404, as if it did not exist', async () => {
    reset();
    fx.project = { id: 'p1', name: 'Team room', organizationId: 'org_source', kind: 'workspace' };
    const res = await installs('p1');
    assert.strictEqual(res.status, 404);
    assert.ok(!call('listBlueprintsFor'), 'no gallery read for a project that carries no Blueprint');
    assert.ok(!call('countInstallsFor'));
});

test('a Solution and a legacy (unclassified) project are still counted', async () => {
    for (const kind of ['solution', null]) {
        reset();
        fx.project = { id: 'p1', name: 'Onboarding', organizationId: 'org_source', kind };
        const res = await installs('p1');
        assert.strictEqual(res.status, 200, `kind ${kind}`);
        assert.deepStrictEqual(res.json, { installsHere: 2, installsElsewhere: 5 });
    }
});
