/**
 * routes/webpagesUsage — "wie gebruikt deze pagina", en wie dat mag vragen.
 *
 * Geen database: auth is gestubd met een vaste sessie, `webpageStore.getWebpage`
 * en de scan zijn gemonkeypatcht, en de router draait op een wegwerp-express-app
 * op 127.0.0.1:0. Zelfde patroon als routes/webpagesGrants.test.js.
 *
 * Twee dingen staan hier op het spel, en ze zijn allebei stil als ze fout gaan:
 *
 *   1. De POORT. De route is eigenaar-gescoopt. Een org-lezer die de pagina
 *      wél mag openen mag hier niets leren — anders vertelt een gepubliceerde
 *      pagina in welke Oplossing van een collega zij ligt en dat er een gesprek
 *      aan hangt.
 *   2. Het VERSCHIL tussen "niets" en "niet gekeken". `unchecked` moet
 *      onverkort door naar de client; valt de hele opzoeking om, dan is het
 *      antwoord een 500 en nooit een leeg `usage` — dat is de ene zin waarop
 *      iemand op Verwijderen drukt.
 *   3. De MONTAGE. De tests hieronder draaien de SUB-router rechtstreeks, en
 *      dat is precies hoe `routes/transcriptions/tags.js` ooit "written,
 *      tested and never mounted" bleef met 39 groene tests. Vandaar het blok
 *      onderaan, dat de samengestelde router uit routes/webpages.js aanroept:
 *      valt `router.use(require('./webpagesUsage'))` weg, dan wordt dit rood
 *      in plaats van dat het tabblad stilletjes op zijn lege staat valt
 *      (`hooks/useUsage.js` maakt van een 404 een `usage: []`).
 *   4. WAT er de scan in gaat. De stub hieronder maakt het makkelijk om alleen
 *      de uitgang te toetsen; de ingang telt net zo goed. `usageForWebpage`
 *      leest `projectId` van de PAGINARIJ, dus een route die alleen het id
 *      doorgeeft laat scanSolution "gecontroleerd, nul rijen" melden over een
 *      pagina die wél in een Oplossing ligt — een echte afhankelijkheid die
 *      als bevestigde nul verdwijnt in plaats van als gat.
 *
 * Draaien: cd server && node --test --test-reporter=tap routes/webpagesUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

// Auth stubben VOORDAT de router laadt — die destructureert requireAuth op
// require-tijd.
const perms = require('../auth/permissions');
perms.requireAuth = (req, res, next) => next();

const webpageStore = require('../stores/webpageStore');
const webpageUsage = require('../core/webpages/webpageUsage');
const usageRouter = require('./webpagesUsage');

const OWNER = { id: 'u1' };
const PAGE = { id: 'wp1', name: 'Prijslijst', userId: OWNER.id, projectId: 'proj-1' };

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
    app.use(usageRouter);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return fn(base);
}

const scan = (over = {}) => ({
    rows: [], partial: [], sources: {}, complete: true, ...over,
});

test('GET /:id/usage geeft de lijst, de niet-gecontroleerde soorten en de standen', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ ...PAGE })],
        [webpageUsage, 'usageForWebpage', async () => scan({
            rows: [{ kind: 'solution', id: 'proj-1', title: 'Offertes', role: 'contains', ownerId: OWNER.id, lastAt: null }],
            partial: ['agent'],
            sources: {
                solution: { status: 'checked', found: 1 },
                chat: { status: 'checked', found: 0 },
                agent: { status: 'unavailable', found: null, reason: 'not-recorded' },
            },
            complete: false,
        })],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/usage`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.usage.length, 1);
        assert.strictEqual(body.usage[0].kind, 'solution');
        assert.strictEqual(body.usage[0].title, 'Offertes');
        // De platte lijst die hooks/useUsage.normaliseUnchecked leest.
        assert.deepStrictEqual(body.unchecked, ['agent']);
        // En de rijkere stand per deelvraag, in de vorm van studio/attention.
        assert.strictEqual(body.sources.chat.found, 0, '"gecontroleerd en leeg" is een getal');
        assert.strictEqual(body.sources.agent.found, null, '"niet gekeken" is geen getal');
        assert.strictEqual(body.complete, false);
    }));
});

test('GET /:id/usage 404t voor een niet-eigenaar, en scant dan niets', async () => {
    let scanned = false;
    await withPatches([
        // De eigenaar-gescoopte opzoeking mist — precies wat een org-lezer krijgt.
        [webpageStore, 'getWebpage', async () => null],
        [webpageUsage, 'usageForWebpage', async () => { scanned = true; return scan(); }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/usage`);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(scanned, false,
            'een niet-eigenaar mag niet leren in welke Oplossing de pagina ligt');
    }));
});

test('GET /:id/usage geeft andermans Oplossing zonder naam terug', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ ...PAGE })],
        [webpageUsage, 'usageForWebpage', async () => scan({
            rows: [{ kind: 'solution', id: 'proj-9', title: 'Overname Acme', role: 'contains', ownerId: 'someone-else', lastAt: null }],
            sources: { solution: { status: 'checked', found: 1 } },
        })],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/usage`);
        const body = await res.json();
        assert.strictEqual(body.usage[0].title, null);
        assert.strictEqual(body.usage[0].foreign, true);
        assert.strictEqual(body.usage[0].role, 'contains', 'wat er stukgaat blijft leesbaar');
    }));
});

test('GET /:id/usage: een omgevallen opzoeking is een 500, nooit een lege lijst', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => { throw new Error('database is down'); }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/usage`);
        assert.strictEqual(res.status, 500);
        const body = await res.json();
        assert.strictEqual(body.usage, undefined,
            'een leeg `usage` bij een storing leest als "niets gebruikt deze pagina"');
    }));
});

test('GET /:id/usage: een scan die zelf omvalt is óók een 500', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ ...PAGE })],
        [webpageUsage, 'usageForWebpage', async () => { throw new Error('scan exploded'); }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/usage`);
        assert.strictEqual(res.status, 500);
        const body = await res.json();
        assert.strictEqual(body.usage, undefined);
    }));
});

// ── wat de route de scan IN stuurt ──────────────────────────────────

test('GET /:id/usage geeft de PAGINARIJ door aan de scan, niet alleen het id', async () => {
    let seen = null;
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ ...PAGE })],
        [webpageUsage, 'usageForWebpage', async (wp) => { seen = wp; return scan(); }],
    ], () => withServer(test, async (base) => {
        await fetch(`${base}/wp1/usage`);
        assert.ok(seen, 'de scan is aangeroepen');
        assert.strictEqual(seen.id, 'wp1');
        assert.strictEqual(seen.projectId, 'proj-1',
            'zonder projectId meldt scanSolution een BEVESTIGDE nul over een pagina die in een Oplossing ligt');
        assert.strictEqual(seen.userId, 'u1');
        assert.strictEqual(seen.name, 'Prijslijst');
    }));
});

// ── de montage ──────────────────────────────────────────────────────
//
// Alles hierboven draait de sub-router los. Dit blok draait de router die de
// app echt mount, zodat een weggevallen `router.use(...)` hier faalt en niet
// pas in het scherm.

const webpagesRouter = require('./webpages');

async function withComposedServer(t, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...OWNER } }; next(); });
    app.use(webpagesRouter);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

test('montage: /:id/usage is bereikbaar via de samengestelde webpages-router', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ ...PAGE })],
        [webpageUsage, 'usageForWebpage', async () => scan({
            rows: [{ kind: 'solution', id: 'proj-1', title: 'Offertes', role: 'contains', ownerId: OWNER.id, lastAt: null }],
            partial: ['chat', 'agent'],
            complete: false,
        })],
    ], () => withComposedServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/usage`);
        assert.strictEqual(res.status, 200,
            'niet gemonteerd = 404, en useUsage maakt daar een lege lijst van — het tabblad valt dan stil terug op "niets gebruikt dit"');
        const body = await res.json();
        assert.strictEqual(body.usage.length, 1);
        assert.deepStrictEqual(body.unchecked, ['chat', 'agent']);
    }));
});

test('montage: /usage wordt niet door GET /:id opgeslokt', async () => {
    // De sub-router hoort VÓÓR `GET /:id` te staan. Staat hij erachter, dan
    // leest die handler "wp1" als id en "usage" als niets, of erger: hij
    // antwoordt met de pagina zelf op een pad dat een usage-lijst moet geven.
    let usageScanned = false;
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ ...PAGE })],
        [webpageUsage, 'usageForWebpage', async () => { usageScanned = true; return scan(); }],
    ], () => withComposedServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/usage`);
        const body = await res.json();
        assert.strictEqual(usageScanned, true, 'de usage-handler heeft geantwoord, niet GET /:id');
        assert.ok(Array.isArray(body.usage), 'het antwoord is de usage-vorm');
    }));
});
