/**
 * routes/webpagesAudience — de vierde rij (Openbaar) en het adres.
 *
 * Geen DB: auth is gestubd, en de stores/services worden per test
 * gemonkeypatcht. Zelfde patroon als routes/webpagesGrants.test.js.
 *
 * Wat hier bewaakt wordt, in volgorde van belang:
 *   1. de KOLOMPOORT wordt toegepast VOORDAT er een byte naar buiten gaat, en
 *      een tabel zonder keuze gaat op nul;
 *   2. de SNAPSHOT wordt geschreven VOORDAT het adres ernaar wijst — een
 *      mislukte snapshot laat geen adres achter dat niets toont;
 *   3. eigenaar-only: een niet-eigenaar leest geen kolomnamen en zet niets
 *      openbaar;
 *   4. openbaar UIT laat het adres staan maar de wijzer niet.
 *
 * Run: node --test --test-force-exit routes/webpagesAudience.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

const perms = require('../auth/permissions');
perms.requireAuth = (req, res, next) => next();

const webpageStore = require('../stores/webpageStore');
const publicAddress = require('../stores/webpage/publicAddress');
const bridgeGrants = require('../stores/webpage/bridgeGrants');
const publicShareStore = require('../stores/webpagePublicShareStore');
const webpageSnapshot = require('../services/webpageSnapshot');
const projectStore = require('../stores/projectStore');
const audienceRouter = require('./webpagesAudience');
// Een schemaweigering reist als fout naar de terminal-handler, dus het
// harnas antwoordt er een zoals index.js dat doet.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const OWNER = { id: 'u1' };

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

async function withServer(t, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...OWNER } }; next(); });
    app.use(audienceRouter);
    app.use(terminalErrorHandler);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

/** De patches die elke test deelt; `over` overschrijft er losse van. */
function base(over = {}) {
    const page = over.page || { id: 'wp1', userId: OWNER.id, name: 'Prijslijst', slug: null, publicShareId: null };
    return [
        [webpageStore, 'getWebpage', over.getWebpage || (async (id, uid) => (uid === OWNER.id ? page : null))],
        [bridgeGrants, 'getBridgeGrants', over.getBridgeGrants || (async () => ({ tables: [] }))],
        [bridgeGrants, 'updateBridgeGrants', over.updateBridgeGrants || (async () => ({ tables: [] }))],
        [publicShareStore, 'findLiveShareById', over.findLiveShareById || (async () => null)],
        [publicShareStore, 'getShareById', over.getShareById || (async () => null)],
        [publicShareStore, 'listSharesForWebpage', over.listSharesForWebpage || (async () => [])],
        [publicShareStore, 'createShare', over.createShare || (async () => ({ share: { id: 'sh_new' }, rawToken: 'raw' }))],
        [publicShareStore, 'revokeShare', over.revokeShare || (async () => {})],
        [publicShareStore, 'deleteShare', over.deleteShare || (async () => {})],
        [publicShareStore, 'updateExpiry', over.updateExpiry || (async () => {})],
        [webpageSnapshot, 'writeSnapshot', over.writeSnapshot || (async () => {})],
        [publicAddress, 'ensureSlug', over.ensureSlug || (async () => 'prijslijst-k3f9x2mq7bd4')],
        [publicAddress, 'setCanonicalShare', over.setCanonicalShare || (async () => true)],
        [projectStore, 'getProject', over.getProject || (async () => null)],
    ];
}

// ── lezen ────────────────────────────────────────────────────────────

test('GET /:id/audience geeft de vier rijen, het adres en de oplossing', async () => {
    const page = {
        id: 'wp1', userId: OWNER.id, name: 'Prijslijst', slug: 'prijslijst-k3f9x2mq7bd4',
        publicShareId: 'sh1', isPublished: true, sharedGroups: [], projectId: 'p1',
    };
    await withPatches(base({
        page,
        getBridgeGrants: async () => ({ tables: [{ datatableId: 't1', mode: 'readwrite', columns: ['naam', 'bsn'], publicColumns: ['naam'] }] }),
        findLiveShareById: async () => ({ id: 'sh1', accessMode: 'unlisted', hasPassword: false, allowedEmails: null, expiresAt: null }),
        listSharesForWebpage: async () => ([{ id: 'sh1' }, { id: 'sh2' }, { id: 'dood', revokedAt: 'x' }]),
        getProject: async () => ({ id: 'p1', name: 'Offertes' }),
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.internal.mode, 'org');
        assert.strictEqual(body.public.on, true);
        assert.strictEqual(body.address.path, '/w/prijslijst-k3f9x2mq7bd4');
        assert.strictEqual(body.columnGate.tables[0].publicMode, 'read');
        assert.strictEqual(body.shareCount, 2, 'ingetrokken shares tellen niet mee');
        assert.deepStrictEqual(body.solution, { id: 'p1', name: 'Offertes' });
    }));
});

test('GET /:id/audience draagt de publieke AI-schakelaar mee uit dezelfde lezing', async () => {
    // De grants worden hier tóch al gelezen (voor de kolompoort). Zonder de
    // ai-plak door te geven zou het scherm over de enige betaalde eigenschap van
    // het publieke oppervlak zwijgen — en dan is "niet gelezen" het antwoord.
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        getBridgeGrants: async () => ({ tables: [], ai: { publicEnabled: true, publicGroundOnPage: true } }),
        findLiveShareById: async () => ({ id: 'sh1', accessMode: 'unlisted' }),
    }), () => withServer(test, async (b) => {
        const body = await (await fetch(`${b}/wp1/audience`)).json();
        assert.strictEqual(body.public.aiKnown, true);
        assert.strictEqual(body.public.aiRuns, true,
            'anonieme bezoekers chatten hier op het budget van de auteur; het scherm hoort dat te weten');
        assert.strictEqual(body.public.aiGroundsOnPage, true);
    }));
});

test('een wijzer naar een INGETROKKEN share leest als "niet openbaar"', async () => {
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh_dood' },
        findLiveShareById: async () => null,     // dezelfde poort als de bezoeker
    }), () => withServer(test, async (b) => {
        const body = await (await fetch(`${b}/wp1/audience`)).json();
        assert.strictEqual(body.public.on, false,
            'het scherm mag niet "openbaar" zeggen over een adres dat 404 geeft');
        assert.strictEqual(body.address.path, '/w/x-abcdefghjkmn', 'het adres zelf blijft bestaan');
    }));
});

test('GET /:id/audience 404t voor een niet-eigenaar, en leest niets', async () => {
    let read = false;
    await withPatches(base({
        getWebpage: async () => null,
        getBridgeGrants: async () => { read = true; return { tables: [] }; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience`);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(read, false, 'kolomnamen van andermans tabel worden niet eens opgehaald');
    }));
});

// ── openbaar zetten ──────────────────────────────────────────────────

test('de kolomkeuze wordt opgeslagen VOORDAT de snapshot wordt geschreven', async () => {
    const order = [];
    await withPatches(base({
        getBridgeGrants: async () => ({ tables: [{ datatableId: 't1', columns: ['naam', 'bsn'], publicColumns: ['naam', 'bsn'] }] }),
        updateBridgeGrants: async (id, uid, patch) => { order.push(['grants', JSON.stringify(patch.tables)]); return { tables: patch.tables }; },
        writeSnapshot: async () => { order.push(['snapshot']); },
        setCanonicalShare: async () => { order.push(['pointer']); return true; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: { t1: ['naam'] } }),
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(order.map(o => o[0]), ['grants', 'snapshot', 'pointer'],
            'poort → bytes → adres; elke andere volgorde kan een adres zonder poort opleveren');
        const savedTables = JSON.parse(order[0][1]);
        assert.deepStrictEqual(savedTables[0].publicColumns, ['naam'],
            'een niet-gekozen kolom mag de poort niet passeren');
        assert.deepStrictEqual(savedTables[0].columns, ['naam', 'bsn'],
            'de INTERNE binding blijft ongemoeid — de poort gaat alleen over wat naar buiten mag');
    }));
});

test('een gebonden tabel die ontbreekt in de keuze gaat op nul kolommen', async () => {
    let saved = null;
    await withPatches(base({
        getBridgeGrants: async () => ({
            tables: [
                { datatableId: 't1', columns: ['a'], publicColumns: ['a'] },
                { datatableId: 't2', columns: ['bsn'], publicColumns: ['bsn'] },
            ],
        }),
        updateBridgeGrants: async (id, uid, patch) => { saved = patch.tables; return { tables: patch.tables }; },
    }), () => withServer(test, async (b) => {
        await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: { t1: ['a'] } }),
        });
        assert.deepStrictEqual(saved.map(t => t.publicColumns), [['a'], []],
            'zonder keuze gaat er niets naar buiten');
    }));
});

test('een mislukte snapshot laat geen adres achter dat naar niets wijst', async () => {
    let pointed = false;
    let deleted = null;
    await withPatches(base({
        writeSnapshot: async () => { throw new Error('rustfs weg'); },
        setCanonicalShare: async () => { pointed = true; return true; },
        deleteShare: async (id) => { deleted = id; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {} }),
        });
        assert.strictEqual(res.status, 500);
        assert.strictEqual(pointed, false, 'de wijzer mag pas na de bytes verspringen');
        assert.strictEqual(deleted, 'sh_new', 'de half aangemaakte share wordt opgeruimd');
    }));
});

test('dezelfde toegangsinstelling houdt de bestaande link — geen nieuw token', async () => {
    let created = false;
    let revoked = false;
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        findLiveShareById: async () => ({ id: 'sh1', createdBy: OWNER.id, accessMode: 'unlisted', allowedEmails: null }),
        createShare: async () => { created = true; return { share: { id: 'sh_new' }, rawToken: 'r' }; },
        revokeShare: async () => { revoked = true; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {} }),
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(created, false, 'een nieuw token zou elke gedeelde link breken zonder dat iemand erom vroeg');
        assert.strictEqual(revoked, false);
    }));
});

test('een andere toegangsinstelling vervangt de link — nieuwe eerst, oude daarna', async () => {
    const order = [];
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        findLiveShareById: async () => ({ id: 'sh1', createdBy: OWNER.id, accessMode: 'unlisted', allowedEmails: null }),
        createShare: async (args) => { order.push(`create:${args.accessMode}`); return { share: { id: 'sh2' }, rawToken: 'r' }; },
        writeSnapshot: async ({ shareId }) => order.push(`snapshot:${shareId}`),
        setCanonicalShare: async (id, uid, sid) => { order.push(`point:${sid}`); return true; },
        revokeShare: async (id) => order.push(`revoke:${id}`),
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {}, accessMode: 'password', password: 'geheim123' }),
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(order, ['create:password', 'snapshot:sh2', 'point:sh2', 'revoke:sh1'],
            'de oude link blijft werken tot de nieuwe er echt staat');
    }));
});

test('een ongeldige toegangsinstelling is een 400, geen halve publicatie', async () => {
    let pointed = false;
    let grants = false;
    await withPatches(base({
        createShare: async () => { throw new Error('Password must be at least 6 characters'); },
        setCanonicalShare: async () => { pointed = true; return true; },
        updateBridgeGrants: async () => { grants = true; return { tables: [] }; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {}, accessMode: 'password', password: 'x' }),
        });
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /at least 6/);
        assert.strictEqual(pointed, false);
        assert.strictEqual(grants, false, 'en ook de kolomkeuze is niet opgeslagen');
    }));
});

test('een vervaldatum in het verleden wordt geweigerd voordat er iets gebeurt', async () => {
    let created = false;
    let grants = false;
    await withPatches(base({
        createShare: async () => { created = true; return { share: { id: 's' }, rawToken: 'r' }; },
        updateBridgeGrants: async () => { grants = true; return { tables: [] }; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: { t1: ['naam', 'bsn'] }, expiresAt: '2000-01-01T00:00:00Z' }),
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual((await res.json()).error, 'expiresAt must be in the future.');
        assert.strictEqual(created, false);
        // De kolomkeuze werd vroeger WEL opgeslagen, ook een verbrede, en de
        // eerstvolgende hersnapshot van een levende link serveerde die dan.
        assert.strictEqual(grants, false, 'ook de kolomkeuze niet: "voordat er iets gebeurt"');
    }));
});

// ── wat de body moet zeggen ─────────────────────────────────────────

/** Een PUT die geweigerd hoort te worden: 400, het veld genoemd, niets geschreven. */
async function refusedPut(body, field) {
    const writes = [];
    const note = (what) => async () => { writes.push(what); return what === 'grants' ? { tables: [] } : { share: { id: 's' }, rawToken: 'r' }; };
    let out = null;
    await withPatches(base({
        updateBridgeGrants: note('grants'),
        createShare: note('share'),
        ensureSlug: async () => { writes.push('slug'); return 'x-abcdefghjkmn'; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        out = { status: res.status, body: await res.json() };
    }));
    assert.strictEqual(out.status, 400, JSON.stringify(out.body));
    assert.ok(out.body.details.some((d) => d.path === field), `de 400 noemt ${field}: ${JSON.stringify(out.body.details)}`);
    assert.deepStrictEqual(writes, [], 'een geweigerd verzoek schrijft niets');
    return out.body;
}

test('on "false" (een string) zet de pagina niet OPENBAAR', async () => {
    // Alleen `on === false` zette uit; al het andere publiceerde.
    const body = await refusedPut({ on: 'false', publicColumns: {} }, 'body.on');
    assert.strictEqual(body.error, 'Say whether the page is public: on is true or false.');
});

test('een vergeten on publiceert niet', async () => {
    await refusedPut({ publicColumns: { t1: ['naam'] } }, 'body.on');
});

test('openbaar aan zonder kolomkeuze wordt geweigerd, niet gelezen als "alles op nul"', async () => {
    // Wie alleen het wachtwoord wilde wijzigen, wiste zo de hele kolomkeuze.
    await refusedPut({ on: true, accessMode: 'password', password: 'geheim123' }, 'body.publicColumns');
});

test('een verschreven toegangsmodus wordt geweigerd vóór de kolomkeuze wordt opgeslagen', async () => {
    const body = await refusedPut({ on: true, publicColumns: {}, accessMode: 'pasword', password: 'geheim123' }, 'body.accessMode');
    assert.strictEqual(body.error, 'accessMode is unlisted, password or email.');
});

test('een e-mailpoort zonder adressen wordt vooraf geweigerd', async () => {
    await refusedPut({ on: true, publicColumns: {}, accessMode: 'email', allowedEmails: [] }, 'body.allowedEmails');
});

test('een achtergebleven wachtwoord bij "unlisted" slaat geen nieuw token', async () => {
    // Het paneel houdt een eerder getypt wachtwoord vast als de keuze terug
    // gaat naar unlisted; accessOptionsChanged telt elk wachtwoord als wijziging.
    let created = false;
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        findLiveShareById: async () => ({ id: 'sh1', createdBy: OWNER.id, accessMode: 'unlisted', allowedEmails: null }),
        createShare: async () => { created = true; return { share: { id: 'sh_new' }, rawToken: 'r' }; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {}, accessMode: 'unlisted', password: 'geheim123' }),
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(created, false, 'de bestaande link blijft werken');
    }));
});

// ── openbaar uitzetten ───────────────────────────────────────────────

test('openbaar uit trekt de canonieke share in en laat het adres staan', async () => {
    const order = [];
    // Eén rij die MEEBEWEEGT met de schrijfactie, zodat het antwoord de stand
    // ná afloop is en niet die van ervoor.
    const rij = { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' };
    await withPatches(base({
        getShareById: async () => ({ id: 'sh1', webpageId: 'wp1', createdBy: OWNER.id, revokedAt: null }),
        setCanonicalShare: async (id, uid, sid) => { order.push(`point:${sid}`); rij.publicShareId = sid; return true; },
        revokeShare: async (id) => order.push(`revoke:${id}`),
        getWebpage: async (id, uid) => (uid === OWNER.id ? { ...rij } : null),
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: false }),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(order, ['point:null', 'revoke:sh1'],
            'eerst het adres losmaken, dan pas intrekken');
        assert.strictEqual(body.public.on, false);
        assert.strictEqual(body.address.path, '/w/x-abcdefghjkmn',
            'het adres overleeft, zodat later opnieuw openbaar zetten dezelfde link geeft');
    }));
});

test('PUT /:id/audience/public 404t voor een niet-eigenaar en schrijft niets', async () => {
    let wrote = false;
    await withPatches(base({
        getWebpage: async () => null,
        updateBridgeGrants: async () => { wrote = true; return {}; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: { t1: ['bsn'] } }),
        });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(wrote, false);
    }));
});

// ── de poort geldt voor ELKE levende link ────────────────────────────
//
// Een snapshot is bevroren: de rijen erin komen uit de `publicColumns` van het
// moment waarop hij is geschreven. Wordt er alleen voor de canonieke share
// opnieuw gesnapshot, dan blijft een losse /share/<token> van dezelfde pagina
// de zojuist weggevinkte kolom serveren — terwijl het scherm zegt van niet.

test('versmallen herschrijft ELKE levende share, niet alleen de canonieke', async () => {
    const snapshotted = [];
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        getBridgeGrants: async () => ({ tables: [{ datatableId: 't1', columns: ['naam', 'email'], publicColumns: ['naam', 'email'] }] }),
        findLiveShareById: async () => ({ id: 'sh1', createdBy: OWNER.id, accessMode: 'unlisted', allowedEmails: null }),
        // sh2 = een losse share uit POST /:id/public-shares; het N-share-model.
        listSharesForWebpage: async () => ([{ id: 'sh1' }, { id: 'sh2' }, { id: 'dood', revokedAt: 'x' }]),
        writeSnapshot: async ({ shareId }) => { snapshotted.push(shareId); },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: { t1: ['naam'] } }),
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(snapshotted, ['sh1', 'sh2'],
            'de losse share serveert anders de weggehaalde kolom gewoon verder');
        assert.strictEqual(snapshotted.includes('dood'), false, 'een ingetrokken share heeft geen bytes meer nodig');
    }));
});

test('ook bij een NIEUWE canonieke share worden de losse shares versmald', async () => {
    const snapshotted = [];
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        findLiveShareById: async () => ({ id: 'sh1', createdBy: OWNER.id, accessMode: 'unlisted', allowedEmails: null }),
        createShare: async () => ({ share: { id: 'sh_new' }, rawToken: 'r' }),
        // sh1 is hierboven net ingetrokken en telt dus niet meer mee.
        listSharesForWebpage: async () => ([{ id: 'sh1', revokedAt: 'x' }, { id: 'sh2' }, { id: 'sh_new' }]),
        writeSnapshot: async ({ shareId }) => { snapshotted.push(shareId); },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {}, accessMode: 'password', password: 'geheim123' }),
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(snapshotted, ['sh_new', 'sh2'],
            'de nieuwe canonieke eerst (bytes vóór wijzer), daarna de overige levende links');
    }));
});

test('een losse share die niet herschreven kan worden is een 500, geen stille belofte', async () => {
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        findLiveShareById: async () => ({ id: 'sh1', createdBy: OWNER.id, accessMode: 'unlisted', allowedEmails: null }),
        listSharesForWebpage: async () => ([{ id: 'sh1' }, { id: 'sh2' }]),
        writeSnapshot: async ({ shareId }) => { if (shareId === 'sh2') throw new Error('rustfs weg'); },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {} }),
        });
        assert.strictEqual(res.status, 500);
        const body = await res.json();
        assert.strictEqual(body.columnGate, undefined,
            'het antwoord mag geen smallere stand beweren dan er geserveerd wordt');
    }));
});

test('een ONLEESBARE sharelijst versmalt niet stilletjes — 500, geen 200', async () => {
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        findLiveShareById: async () => ({ id: 'sh1', createdBy: OWNER.id, accessMode: 'unlisted', allowedEmails: null }),
        listSharesForWebpage: async () => { throw new Error('db weg'); },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {} }),
        });
        assert.strictEqual(res.status, 500,
            '"leeg" en "onleesbaar" zijn niet hetzelfde: onbekend mag geen publicatie afronden');
    }));
});

// ── onbekend versmalt, óók in de PUT ─────────────────────────────────
//
// `liveCanonicalShare` geeft twee dingen terug: de share én of hij te LEZEN
// was. Gooit `findLiveShareById` (DB-hikje, replica net weg), dan is de share
// null zonder dat dat "er is er nog geen" betekent. Wie alleen `share`
// destructureert, laat de PUT precies de tak in lopen die een NIEUWE link
// aanmaakt en het intrekken van de oude overslaat.

test('een ONLEESBARE canonieke share publiceert niet — geen tweede levende link', async () => {
    const order = [];
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' },
        findLiveShareById: async () => { throw new Error('db hikje'); },
        createShare: async (a) => { order.push(`create:${a.accessMode}`); return { share: { id: 'sh2' }, rawToken: 'r' }; },
        setCanonicalShare: async (id, uid, sid) => { order.push(`point:${sid}`); return true; },
        revokeShare: async (id) => { order.push(`revoke:${id}`); return true; },
        listSharesForWebpage: async () => ([{ id: 'sh1' }]),
        writeSnapshot: async ({ shareId }) => { order.push(`snap:${shareId}`); },
    }), () => withServer(test, async (b) => {
        // De eigenaar wisselt het wachtwoord van de openbare link.
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: true, publicColumns: {}, accessMode: 'password', password: 'nieuw12345' }),
        });
        assert.strictEqual(res.status, 500,
            'onbekend mag geen publicatie afronden — "kon de stand niet lezen" is geen "er is er nog geen"');
        assert.deepStrictEqual(order, [],
            'er wordt geen tweede link aangemaakt naast de oude, die anders met het OUDE wachtwoord blijft leven');
        const body = await res.json();
        assert.strictEqual(body.rawToken, undefined, 'en er gaat geen nieuw token terug');
    }));
});

// ── openbaar uit raakt ALLEEN het adres ──────────────────────────────
//
// De off-tak trekt uitsluitend de CANONIEKE share in. Een losse share uit
// POST /:id/public-shares blijft daarna leven en /share/<token> serveert de
// bevroren snapshot gewoon door — tabelrijen incluis. Dat mag, het is het
// N-share-model, maar het ANTWOORD moet het kunnen zeggen: `public.on:false`
// naast een shareCount die de overgebleven links telt. Zonder dat getal leest
// het scherm "Off" over een pagina die anoniem bereikbaar is.

test('openbaar uit laat de LOSSE shares leven, en het antwoord telt ze', async () => {
    const rij = { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: 'sh1' };
    const shares = [
        { id: 'sh1', webpageId: 'wp1', createdBy: OWNER.id, revokedAt: null },
        { id: 'sh2', webpageId: 'wp1', createdBy: OWNER.id, revokedAt: null },
    ];
    await withPatches(base({
        getShareById: async (id) => shares.find(s => s.id === id) || null,
        setCanonicalShare: async (id, uid, sid) => { rij.publicShareId = sid; return true; },
        revokeShare: async (id) => { const s = shares.find(x => x.id === id); if (s) s.revokedAt = 'nu'; return true; },
        deleteShare: async () => true,
        listSharesForWebpage: async () => shares.map(s => ({ ...s })),
        getWebpage: async (id, uid) => (uid === OWNER.id ? { ...rij } : null),
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience/public`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: false }),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.public.on, false, 'het adres bedient niets meer');
        assert.strictEqual(shares.find(s => s.id === 'sh2').revokedAt, null,
            'een losse share is geen adres en wordt met opzet niet meegetrokken');
        assert.strictEqual(body.shareCount, 1,
            'de overgebleven losse link moet telbaar blijven — anders kan het scherm hem niet melden');
        assert.strictEqual(body.shareCountKnown, true);
    }));
});

test('een verlopen share telt niet mee als "staat nog open"', async () => {
    const gisteren = new Date(Date.now() - 86_400_000).toISOString();
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: null },
        listSharesForWebpage: async () => ([
            { id: 'sh2', expiresAt: gisteren },
            { id: 'sh3', revokedAt: 'x' },
        ]),
    }), () => withServer(test, async (b) => {
        const body = await (await fetch(`${b}/wp1/audience`)).json();
        assert.strictEqual(body.shareCount, 0,
            'dezelfde liveness-toets als de bezoeker: verlopen is dood');
        assert.strictEqual(body.shareCountKnown, true, '"nul" is hier een gelezen feit');
    }));
});

test('een ONLEESBARE sharelijst is geen "er staat niets meer open"', async () => {
    await withPatches(base({
        page: { id: 'wp1', userId: OWNER.id, name: 'x', slug: 'x-abcdefghjkmn', publicShareId: null },
        listSharesForWebpage: async () => { throw new Error('db weg'); },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/wp1/audience`);
        assert.strictEqual(res.status, 200, 'de poort blijft bedienbaar');
        const body = await res.json();
        assert.strictEqual(body.shareCountKnown, false,
            '"leeg" en "onleesbaar" moeten te onderscheiden blijven');
    }));
});
