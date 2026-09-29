/**
 * O4 — de releasenotitie bij POST /:id/package/export.
 *
 * De notitie is de INHOUDSOPGAVE van een versie: per entiteit added/changed/
 * unchanged, plus — als er een model voor is — één regel over wat er veranderde.
 * De Versies-tab rendert precies dat.
 *
 * Twee dingen moeten hier kloppen, en ze horen bij elkaar:
 *
 *   1. DE SERVER SCHRIJFT HEM. Hij stond eerst als `req.body?.notes` in de
 *      publicatie-aanroep. Niemand vulde dat veld — de enige client stuurt
 *      `{ save }` — dus elke release kreeg `{}` en de Versies-tab las ELKE
 *      versie als "niet vastgelegd", ook de publicatie van vandaag.
 *   2. DE CLIENT SCHRIJFT HEM NIET. Dezelfde regel liet de schrijfkant
 *      openstaan: de store toetst alleen "plat object ≤ 64 KB", dus een
 *      eigenaar kon zelf een `entities`-lijst posten en het scherm toonde die
 *      verzonnen lijst als DE vastgelegde diff — met een entiteit die in
 *      werkelijkheid veranderde netjes op 'unchanged'. Een diff is een uitspraak
 *      van de server over twee manifesten.
 *
 * En de derde: PUBLICEREN MAG NOOIT OP DE NOTITIE STUKLOPEN. Valt de tekstlaag
 * om, past de envelop niet, is de vorige versie niet te lezen — dan publiceert
 * de release zonder notitie, nooit niet.
 *
 * Hermetisch: capture, de stores, de gates en de LLM-laag zijn via require.cache
 * vervangen. Er komt geen database en geen provider aan te pas.
 *
 * Run: cd server && node --test routes/projects/packaging.notes.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { buildManifest } = require('../../projects/packaging/manifest');

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('../../license/middleware', {
    requireFeature: () => (req, res, next) => next(),
    featureAllowedForRequest: async () => ({ allowed: true }),
});
stub('../../auth/projectAccess', { requireProjectRole: () => (req, res, next) => next() });

const fx = {
    project: null,
    blueprints: [],
    galleryById: new Map(),
    listThrows: false,
    published: null,
    captured: null,
    summary: 'De stappen zijn gewijzigd.',
    chatThrows: false,
    calls: [],
};
const record = (name, args) => { fx.calls.push({ name, args }); return args; };
const called = (name) => fx.calls.filter(c => c.name === name);

stub('../../stores/projectStore', {
    getProject: async () => fx.project,
    logActivity: async (projectId, actorId, action, details) => record('logActivity', { projectId, actorId, action, details }),
});
stub('../../core/projectFeed', {
    emitProjectEvent: async (projectId, event) => record('emitProjectEvent', { projectId, event }),
});
stub('../../projects/packaging/capture', {
    captureSolution: async () => ({ ok: true, manifest: fx.captured }),
});
stub('../../stores/userStore', { getOrganization: async () => ({ id: 'org_project', name: 'Acme' }) });
stub('../../stores/blueprintStore', {
    MAX_NOTES_BYTES: 64 * 1024,
    listBlueprintsFor: async (args) => {
        record('listBlueprintsFor', args);
        if (fx.listThrows) throw new Error('de galerij is niet te lezen');
        return fx.blueprints;
    },
    getBlueprintById: async (id) => { record('getBlueprintById', { id }); return fx.galleryById.get(id) || null; },
    publishRelease: async (args) => { record('publishRelease', args); return fx.published; },
});

// De LLM-laag: modelResolver trekt anders configStore en dus de pool mee.
stub('../../core/llm/modelResolver', {
    resolveModelForTierName: async (tier, opts) => { record('resolveModel', { tier, opts }); return 'fast-model'; },
});
stub('../../core/llm/llmClient', {
    chatForcedTool: async (modelId, messages) => {
        record('chatForcedTool', { modelId, messages });
        if (fx.chatThrows) throw new Error('provider weg');
        return { structured: { summary: fx.summary } };
    },
});

const router = require('./packaging');

// ── Fixtures ────────────────────────────────────────────────────────────────

const routine = (over = {}) => ({
    ref: 'aut_1', kind: 'automation', title: 'Herinnering Van Dijk BV',
    description: 'Stuurt een betalingsherinnering', triggerType: 'schedule',
    definition: { steps: [{ id: 's1', type: 'send_email', config: { to: 'jan@vandijk.nl' } }] },
    ...over,
});

const manifestOf = (entities, version = 1) =>
    buildManifest({ project: { id: 'p1', name: 'Onboarding' }, entities, version });

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
    // De vorige versie in de galerij: dezelfde routine, andere omschrijving.
    fx.blueprints = [
        { id: 'bp_mine', solutionKey: 'sol_p1', createdBy: 'alice', version: 1 },
        { id: 'bp_bob', solutionKey: 'sol_p1', createdBy: 'bob', version: 7 },
        { id: 'bp_ander', solutionKey: 'sol_p9', createdBy: 'alice', version: 1 },
    ];
    fx.galleryById = new Map([
        ['bp_mine', { id: 'bp_mine', manifest: manifestOf({ automations: [routine({ description: 'oud' })] }) }],
        ['bp_bob', { id: 'bp_bob', manifest: manifestOf({ automations: [routine({ ref: 'aut_9' })] }, 7) }],
    ]);
    fx.captured = manifestOf({ automations: [routine(), routine({ ref: 'aut_2', title: 'Export' })] }, 2);
    fx.published = { blueprint: { id: 'bp_mine', version: 2, manifest: fx.captured }, release: { id: 'rel_1' } };
    fx.listThrows = false;
    fx.chatThrows = false;
    fx.summary = 'De stappen zijn gewijzigd.';
    fx.calls.length = 0;
}

const notesSent = () => called('publishRelease')[0]?.args?.notes;

// ── 1. De server schrijft de notitie ────────────────────────────────────────

test('een publicatie krijgt de diff tegen de vórige versie van deze maker mee', async () => {
    reset();
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);

    // De linkerkant komt uit de galerijrij van ALICE — de versieserie loopt per
    // maker, dus de rij van bob is een andere serie en niet de vorige versie.
    assert.deepStrictEqual(called('getBlueprintById').map(c => c.args.id), ['bp_mine']);
    assert.deepStrictEqual(called('listBlueprintsFor')[0].args,
        { userId: 'alice', organizationId: 'org_project' });

    const notes = notesSent();
    assert.deepStrictEqual(Object.keys(notes).sort(), ['entities', 'omitted', 'textsDropped']);
    assert.deepStrictEqual(notes.entities.map(n => [n.entityId, n.change]), [
        ['aut_1', 'changed'],
        ['aut_2', 'added'],
    ]);
    assert.strictEqual(notes.entities[0].text, 'De stappen zijn gewijzigd.',
        'de zin hoort bij de gewijzigde regel');
    assert.strictEqual(notes.entities[1].text, null, 'een toevoeging heeft geen diff om over te schrijven');
});

test('de eerste publicatie vergelijkt met niets, en kost geen enkele modelaanroep', async () => {
    reset();
    fx.blueprints = [];
    await exportProject({ save: true });
    assert.deepStrictEqual(called('getBlueprintById'), []);
    assert.deepStrictEqual(called('chatForcedTool'), [], 'er valt niets te vergelijken, dus niets te beschrijven');
    assert.deepStrictEqual(notesSent().entities.map(n => n.change), ['added', 'added']);
});

test('de modelaanroep draagt de organisatie van het PROJECT en de gebruiker', async () => {
    // Zonder die context valt de tier-resolutie terug op de globale fast-tier;
    // dan gaat de vorm van deze Oplossing naar het model van de instantie in
    // plaats van naar het model dat deze werkruimte koos.
    reset();
    await exportProject({ save: true });
    assert.deepStrictEqual(called('resolveModel')[0].args.opts, { userOrgId: 'org_project', userId: 'alice' });
});

// ── 2. De client schrijft hem niet ──────────────────────────────────────────

test('een notitie uit de request-body bereikt de database NIET', async () => {
    reset();
    const forged = {
        entities: [
            { kind: 'automation', entityId: 'aut_1', name: 'Onschuldig', change: 'unchanged', text: 'Er is niets veranderd.' },
        ],
        omitted: 0,
        textsDropped: false,
    };
    // Sinds het schema (routes/projects/schemas.js) is `notes` geen sleutel
    // die de export neemt: de request wordt geweigerd met die naam, en er
    // wordt niets gepubliceerd.
    const refused = await exportProject({ save: true, notes: forged });
    assert.strictEqual(refused.status, 400);
    assert.deepStrictEqual(called('publishRelease'), []);

    await exportProject({ save: true });
    const notes = notesSent();
    assert.strictEqual(notes.entities.find(n => n.entityId === 'aut_1').change, 'changed',
        'de server vergelijkt zelf; een client die "unchanged" beweert wint dat niet');
    assert.ok(!JSON.stringify(notes).includes('Er is niets veranderd.'));
});

// ── 3. Publiceren loopt nooit stuk op de notitie ────────────────────────────

test('een onleesbare vorige versie kost de notitie, niet de publicatie', async () => {
    reset();
    fx.listThrows = true;
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json._savedAs, 'bp_mine', 'er is gewoon gepubliceerd');
    assert.strictEqual(notesSent(), null, 'geen notitie is een eerlijker antwoord dan een halve');
});

test('een omgevallen model kost de ZIN, niet de diff', async () => {
    reset();
    fx.chatThrows = true;
    await exportProject({ save: true });
    const notes = notesSent();
    assert.deepStrictEqual(notes.entities.map(n => [n.change, n.text]), [['changed', null], ['added', null]]);
});

test('een notitie die niet binnen MAX_NOTES_BYTES past wordt weggelaten, niet geweigerd', async () => {
    // publishRelease GOOIT boven die grens, en dat zou een publicatie
    // tegenhouden vanwege een bijzaak. De route legt de envelop daarom naast de
    // ECHTE constante van de store, niet naast een kopie.
    reset();
    const store = require('../../stores/blueprintStore');
    const original = store.MAX_NOTES_BYTES;
    store.MAX_NOTES_BYTES = 10;
    try {
        const res = await exportProject({ save: true });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(notesSent(), null);
    } finally {
        store.MAX_NOTES_BYTES = original;
    }
});

// ── 4. De publicatie wordt omgeroepen — als POKE, niet als antwoord ─────────

test('na een geslaagde publicatie gaat er een blueprint.published de deur uit', async () => {
    reset();
    await exportProject({ save: true });

    const emitted = called('emitProjectEvent')[0];
    assert.ok(emitted, 'zonder afzender ververst de Versies-tab nooit live');
    assert.strictEqual(emitted.args.projectId, 'p1');
    assert.deepStrictEqual(emitted.args.event, { kind: 'blueprint.published', actorId: 'alice' });

    // GEEN Blueprint-id, geen versienummer, geen naam: een projectlid buiten de
    // organisatie van de Blueprint zou anders via de activiteitenstroom een
    // versie op zijn scherm krijgen die de galerijlijst hem juist onthoudt.
    const asText = JSON.stringify(emitted.args.event);
    for (const leak of ['bp_mine', 'sol_p1', 'Onboarding', 'Acme']) {
        assert.ok(!asText.includes(leak), `${leak} hoort niet in een poke`);
    }

    // En de pollende fallback leest project_activity, dus die helft gaat ook mee.
    const logged = called('logActivity')[0];
    assert.strictEqual(logged.args.action, 'blueprint.published');
    assert.deepStrictEqual(logged.args.details, {});
});

test('een export ZONDER publicatie roept niets om', async () => {
    reset();
    await exportProject({});
    assert.deepStrictEqual(called('emitProjectEvent'), []);
    assert.deepStrictEqual(called('publishRelease'), []);
});

test('een mislukte publicatie roept ook niets om', async () => {
    reset();
    fx.published = null;                 // publishRelease geeft niets terug → TypeError
    const res = await exportProject({ save: true });
    assert.ok(res.json._saveError, 'de aanroeper hoort te horen dat het misging');
    assert.deepStrictEqual(called('emitProjectEvent'), [],
        'er is niets gepubliceerd, dus er valt niets om te roepen');
});
