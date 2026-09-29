/**
 * Wat de webpagina-routes aannemen, en wat ze zeggen als ze weigeren
 * (routes/webpages/*.js).
 *
 * Vijf stille terugvallen stonden hier, allemaal onder een 200:
 *
 *   - `PUT /:id/chat {"mesages": [...]}` WISTE de hele gespreksgeschiedenis
 *     van de bouw-AI. `Array.isArray(req.body?.messages) ? … : []` maakte van
 *     een typefout een lege lijst, en het antwoord was `{success:true,count:0}`.
 *   - `PATCH /:id/publish {"isPublished": "false"}` PUBLICEERDE de pagina: de
 *     store schrijft `!!isPublished`, en de tekst "false" is waar. Het antwoord
 *     echode `isPublished: "false"` terug.
 *   - `PATCH /:id/publish {}` depubliceerde hem, om dezelfde reden vanaf de
 *     andere kant, en wiste de gepinde momentopname.
 *   - `POST /:id/public-shares {"accesMode":"password", "password":"…"}` maakte
 *     een link ZONDER wachtwoord: `accessMode` viel terug op 'unlisted', de
 *     smalste keuze op het scherm werd het wijdste publiek dat er is.
 *   - `POST / {"framework":"raect"}` bouwde de pagina als `vanilla`.
 *
 * Wat dit bestand vastlegt is het deel waar een beller iets mee kan:
 *
 *   - de 400 NOEMT het veld (`body.isPublished`), niet alleen "ongeldig";
 *   - de boodschap is een zin, ook voor een veld dat simpelweg ontbreekt;
 *   - de stores worden niet bereikt, dus een geweigerd verzoek verandert niets.
 *
 * Draaien: cd server && node --test routes/webpages/webpages.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const perms = require('../../auth/permissions');
perms.requireAuth = (req, res, next) => next();
const auth = require('../../auth');
auth.requireActiveOrgForMutations = () => (req, res, next) => next();
auth.validateSharedGroupsForOrg = async (_org, groups) => (Array.isArray(groups) ? groups : []);
auth.hasPermission = async () => true;
const audience = require('../../auth/audience');
audience.resolveAudienceContext = async (req) => ({
    userId: req.session.user.id, orgIds: ['org1'], userGroups: [],
});

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const publicShareStore = require('../../stores/webpagePublicShareStore');
const webpageSnapshot = require('../../services/webpageSnapshot');
const usageSync = require('../../core/webpages/webpageUsageSync');
const shareReconciler = require('../../core/webpages/webpageShareReconciler');

const webpagesRouter = require('../webpages');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

const OWNER = { id: 'alice', organizationId: 'org1' };
const PAGE = {
    id: 'wp1', userId: 'alice', name: 'Page', isPublished: false, sharedGroups: [],
    organizationId: 'org1', publishedVersionId: 'v1', projectId: null,
    htmlSha: 'h1', cssSha: 'c1', jsSha: 'j1', dbSha: '',
    htmlSize: 10, cssSize: 5, jsSize: 5, dbSize: 0, settings: {},
    knowledgeBaseIds: [],
};

// Elke store-aanroep komt in `touched` terecht. Een geweigerd verzoek moet
// hem leeg laten.
let touched = [];
const spy = (what, value) => (...args) => { touched.push({ what, args }); return value; };

/**
 * De echte router achter een echte express-app, mét de terminale
 * foutafhandelaar erachter — net als in index.js. Zonder die laatste wordt
 * `next(err)` uit een schema express' eigen 500-pagina in plaats van de 400
 * die de server werkelijk verstuurt.
 */
function stubs() {
    return [
        [webpageStore, 'getWebpage', async (id, userId) => (userId === PAGE.userId ? { ...PAGE } : null)],
        [webpageStore, 'getWebpageRaw', async () => ({ ...PAGE })],
        [webpageStore, 'canReadWebpageAsync', async () => true],
        [webpageStore, 'getSources', async () => []],
        [webpageStore, 'listExtraFiles', async () => []],
        [webpageStore, 'getChatMessages', async () => []],
        [webpageStore, 'setChatMessages', spy('setChatMessages', Promise.resolve(true))],
        [webpageStore, 'setWebpagePublished', spy('setWebpagePublished', Promise.resolve(true))],
        [webpageStore, 'setPublishedVersion', spy('setPublishedVersion', Promise.resolve(true))],
        [webpageStore, 'updateWebpageMetadata', spy('updateWebpageMetadata', Promise.resolve(true))],
        [webpageStore, 'upsertExtraFile', spy('upsertExtraFile', Promise.resolve({ path: 'src/App.jsx' }))],
        [webpageStore, 'deleteExtraFile', spy('deleteExtraFile', Promise.resolve(true))],
        [webpageStore, 'addSource', spy('addSource', Promise.resolve({ id: 's1' }))],
        [webpageStore, 'cloneWebpage', spy('cloneWebpage', Promise.resolve({ ...PAGE, id: 'wp2' }))],
        [webpageStore, 'deleteWebpage', spy('deleteWebpage', Promise.resolve({ knowledgeBaseIds: [] }))],
        [webpageStore, 'getVersions', async () => []],
        [webpageStore, 'getVersionMeta', async () => ({ id: 'v1', webpageId: 'wp1', seq: 1 })],
        [webpageStore, 'createVersion', spy('createVersion', Promise.resolve({ id: 'v2' }))],
        [webpageDbStore, 'flush', async () => {}],
        [webpageDbStore, 'invalidate', async () => {}],
        [webpageDbStore, 'query', spy('dbQuery', Promise.resolve({ rows: [] }))],
        [webpageDbStore, 'exec', spy('dbExec', Promise.resolve({ changes: 0 }))],
        [publicShareStore, 'countLiveSharesForWebpages', async (ids) => new Map(ids.map(i => [i, 0]))],
        [publicShareStore, 'listSharesForWebpage', async () => []],
        [publicShareStore, 'getRetrievableTokens', async () => new Map()],
        [publicShareStore, 'createShare', spy('createShare', Promise.resolve({ share: { id: 'sh1' }, rawToken: 'tok' }))],
        [publicShareStore, 'getShareById', async () => ({ id: 'sh1', webpageId: 'wp1', createdBy: 'alice', revokedAt: null })],
        [publicShareStore, 'updateExpiry', spy('updateExpiry', Promise.resolve(true))],
        [webpageSnapshot, 'writeSnapshot', async () => {}],
        [usageSync, 'reconcileWebpageUsageDetached', () => {}],
        [usageSync, 'purgeWebpageUsage', async () => {}],
        [shareReconciler, 'reSnapshotWebpageSharesDetached', () => {}],
    ];
}

let base = null;
test.before(async (t) => {
    const originals = stubs().map(([obj, key, value]) => {
        const orig = obj[key];
        obj[key] = value;
        return [obj, key, orig];
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...OWNER } }; next(); });
    app.use(webpagesRouter);
    app.use(terminalErrorHandler);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        server.close();
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
});

test.beforeEach(() => { touched = []; });

async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* leeg of geen JSON */ }
    return { statusCode: res.status, body: parsed };
}

/** Geweigerd met 400, het genoemde veld staat in `details`, niets aangeraakt. */
async function refuses(method, path, body, field) {
    const res = await call(method, path, body);
    const what = `${method} ${path} ${JSON.stringify(body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} → ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `de 400 moet ${field} noemen; hij zei ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'een geweigerd verzoek mag de store niet bereiken');
}

// ═══ PUT /:id/chat — de geschiedenis van de bouw-AI ═════════════════

test('een verkeerd gespelde berichtenlijst wist de chat niet meer, maar weigert', async () => {
    await refuses('PUT', '/wp1/chat', { mesages: [{ role: 'user' }] }, 'body');
    await refuses('PUT', '/wp1/chat', {}, 'body.messages');
});

test('de berichten die het scherm echt verstuurt worden nog steeds opgeslagen', async () => {
    const res = await call('PUT', '/wp1/chat', { messages: [{ role: 'user', content: 'hoi' }] });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(touched.find(x => x.what === 'setChatMessages').args[2].length, 1);
});

test('leegmaken blijft DELETE, en die neemt geen body aan', async () => {
    const ok = await call('DELETE', '/wp1/chat');
    assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(touched.find(x => x.what === 'setChatMessages').args[2], []);
    touched = [];
    await refuses('DELETE', '/wp1/chat', { messages: [] }, 'body');
});

// ═══ PATCH /:id/publish ═════════════════════════════════════════════

test('de tekst "false" publiceert niet meer, maar wordt bij naam geweigerd', async () => {
    // De store schrijft `!!isPublished`, en "false" is waar: dit ZETTE de
    // pagina open voor de hele organisatie en pinde er een momentopname bij.
    await refuses('PATCH', '/wp1/publish', { isPublished: 'false' }, 'body.isPublished');
    await refuses('PATCH', '/wp1/publish', { isPublished: 'true' }, 'body.isPublished');
});

test('een publicatie zonder antwoord depubliceert niet meer stilzwijgend', async () => {
    const res = await call('PATCH', '/wp1/publish', {});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Zeg of de pagina gepubliceerd moet zijn: isPublished is true of false.');
    assert.deepStrictEqual(touched, [], 'en de gepinde momentopname blijft staan');
});

test('een sleutel die de publicatieroute niet leest wordt geweigerd', async () => {
    await refuses('PATCH', '/wp1/publish', { isPublished: true, isPublic: true }, 'body');
});

test('de body die het scherm echt verstuurt publiceert nog steeds', async () => {
    const res = await call('PATCH', '/wp1/publish', { isPublished: true, sharedGroups: ['g1'] });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const write = touched.find(x => x.what === 'setWebpagePublished');
    assert.strictEqual(write.args[1], true);
    assert.deepStrictEqual(write.args[3], ['g1']);
});

// ═══ POST /:id/public-shares — het wijdste publiek dat er is ════════

test('een verkeerd gespelde toegangsvorm maakt geen link zonder wachtwoord meer', async () => {
    // `accessMode` viel terug op 'unlisted': wie een wachtwoord instelde kreeg
    // een adres dat iedereen met de link opent, met de URL eronder.
    await refuses('POST', '/wp1/public-shares', { accesMode: 'password', password: 'hunter22' }, 'body');
});

test('een openbaar adres krijg je niet door te zwijgen', async () => {
    await refuses('POST', '/wp1/public-shares', { title: 'Page' }, 'body.accessMode');
});

test('een toegangsvorm die niemand implementeert wordt geweigerd', async () => {
    const res = await call('POST', '/wp1/public-shares', { accessMode: 'pasword', password: 'hunter22' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Kies hoe de link beschermd is: unlisted, password of email.');
    assert.deepStrictEqual(touched, []);
});

test('een wachtwoord van het verkeerde type komt niet meer langs de lengtepoort', async () => {
    // `(123456).length` is undefined en `undefined < 6` is onwaar, dus het
    // getal liep de "minstens 6 tekens"-controle in de store straal voorbij.
    await refuses('POST', '/wp1/public-shares', { accessMode: 'password', password: 123456 }, 'body.password');
});

test('een toegelaten adres dat leeg is wordt geweigerd in plaats van weggefilterd', async () => {
    // Leeg-na-trimmen viel in de store weg: een e-mailpoort met een LEGE lijst
    // is een link die niemand meer kan openen, onder een 200 met de URL erbij.
    await refuses('POST', '/wp1/public-shares', { accessMode: 'email', allowedEmails: ['  '] }, 'body.allowedEmails.0');
});

test('de body die het deelscherm echt verstuurt maakt nog steeds een link', async () => {
    const res = await call('POST', '/wp1/public-shares', {
        accessMode: 'unlisted', title: 'Page', expiresAt: null,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(touched.find(x => x.what === 'createShare').args[0].accessMode, 'unlisted');
});

test('een vervaldatum die niet wordt gelezen is geen 200 meer', async () => {
    await refuses('PATCH', '/wp1/public-shares/sh1', { expiresA: null }, 'body');
});

// ═══ POST / — een pagina maken ══════════════════════════════════════

test('een framework dat niemand bouwt wordt geweigerd, niet stil als vanilla gebouwd', async () => {
    const res = await call('POST', '/', { name: 'Test', framework: 'raect' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /^Kies een framework:/);
    assert.ok(res.body.details.some(d => d.path === 'body.framework'));
    assert.deepStrictEqual(touched, []);
});

test('een runtime-niveau dat niemand kent wordt geweigerd', async () => {
    await refuses('POST', '/', { name: 'Test', runtime: 'heavy' }, 'body.runtime');
});

test('een sleutel die de maakroute niet leest wordt geweigerd', async () => {
    await refuses('POST', '/', { name: 'Test', template: 'blog' }, 'body');
});

// ═══ PUT /:id — opslaan ═════════════════════════════════════════════

test('een verkeerd gespelde naam wordt geweigerd in plaats van stil overgeslagen', async () => {
    // `{"nmae":"x","html":"…"}` sloeg de html op, liet de naam staan en
    // antwoordde `{success:true}` — een hernoeming die nooit gebeurde.
    await refuses('PUT', '/wp1', { nmae: 'Nieuw', html: '<p>x</p>' }, 'body');
});

test('een naam die geen tekst is wordt geweigerd', async () => {
    await refuses('PUT', '/wp1', { name: { nl: 'Naam' } }, 'body.name');
});

// ═══ De paginadatabank ══════════════════════════════════════════════

test('benoemde parameters draaien de statement niet meer zonder bindingen', async () => {
    // `Array.isArray(params) ? params : []` maakte van `{":id":3}` een lege
    // lijst, en een statement zonder waarden geeft andere rijen terug.
    await refuses('POST', '/wp1/db/query', { sql: 'SELECT 1', params: { ':id': 3 } }, 'body.params');
});

test('een lege SQL blijft een 400 met dezelfde zin', async () => {
    const res = await call('POST', '/wp1/db/exec', { sql: '   ' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'sql is required');
});

// ═══ De bestandsroutes ══════════════════════════════════════════════

test('een verkeerd gespeld pad geeft geen inhoudsopgave meer terug', async () => {
    // `?paht=src/App.jsx` viel weg en de route antwoordde met de LIJST — een
    // client die dacht een bestand te lezen kreeg een map.
    await refuses('GET', '/wp1/files?paht=src%2FApp.jsx', undefined, 'query');
});

test('een onbekende querysleutel op NO_QUERY krijgt een zin, niet zods eigen "Unrecognized key(s)"', async () => {
    // GET /:id/sources draagt `query: NO_QUERY` (routes/webpages/sources.js) —
    // anders dan de /files-route hierboven, die zijn eigen FileQuery gebruikt.
    const res = await call('GET', '/wp1/sources?bogus=1', undefined);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Dit accepteert geen queryparameters.');
});

test('the thumbnail accepts the ?v= the webpage card sends', async () => {
    // WebpageCard.jsx asks for `/thumbnail?v=<thumbnailSha>`. Under NO_QUERY
    // every card got a 400 and showed no preview. PAGE has no thumbnail, so a
    // request that gets past validation ends in the route's own 404.
    const res = await call('GET', '/wp1/thumbnail?v=abc123', undefined);
    assert.strictEqual(res.statusCode, 404);
});

test('the thumbnail still refuses a query key it does not read', async () => {
    const res = await call('GET', '/wp1/thumbnail?bogus=1', undefined);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Dit accepteert alleen ?v als queryparameter.');
});

test('een bronsoort met een verkeerde aanbieder wordt niet meer als Drive weggeschreven', async () => {
    // `provider === 'microsoft' ? 'onedrive' : 'gdrive'`: élke andere waarde
    // — 'Microsoft' met een hoofdletter — werd een Google Drive-bron.
    await refuses('POST', '/wp1/sources/drive', { provider: 'Microsoft', files: [{ name: 'a' }] }, 'body.provider');
});

test('een tekstbron zonder tekst houdt dezelfde zin', async () => {
    const res = await call('POST', '/wp1/sources/text', {});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Text content required');
});

// ═══ Verwijderen en klonen ══════════════════════════════════════════

test('een bevestiging die niemand zo spelt wordt geweigerd in plaats van gelezen als "nee"', async () => {
    await refuses('DELETE', '/wp1?confirm=ja', undefined, 'query.confirm');
    await refuses('DELETE', '/wp1?confrim=1', undefined, 'query');
});

test('een verwijdering bevestigt nog steeds op beide spellingen die een URL draagt', async () => {
    for (const q of ['?confirm=1', '?confirm=true']) {
        touched = [];
        const res = await call('DELETE', `/wp1${q}`);
        assert.strictEqual(res.statusCode, 200, `${q} → ${JSON.stringify(res.body)}`);
        assert.ok(touched.some(x => x.what === 'deleteWebpage'), `${q} moet echt verwijderen`);
    }
});

test('een versiebladwijzer die niet bestaat wordt geweigerd', async () => {
    await refuses('GET', '/wp1/versions?page=2', undefined, 'query');
});
