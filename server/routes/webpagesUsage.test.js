/**
 * routes/webpagesUsage — "who uses this page", and who may ask that.
 *
 * No database: auth is stubbed with a fixed session, `webpageStore.getWebpage` and the scan are
 * monkeypatched, and the router runs on a throwaway express app on 127.0.0.1:0. Same pattern as
 * routes/webpagesGrants.test.js.
 *
 * Two things are at stake here, and both are silent when they go wrong:
 *
 *   1. The GATE. The route is owner-scoped. An org reader who may open the page must learn
 *      nothing here — otherwise a published page would tell in which Solution of a colleague it
 *      lies and that a conversation hangs on it.
 *   2. The DIFFERENCE between "nothing" and "not checked". `unchecked` must go to the client
 *      unchanged; if the whole lookup falls over, the answer is a 500 and never an empty `usage` —
 *      that is the one sentence someone clicks on Delete on.
 *   3. The MOUNTING. The tests below run the SUB-router directly, and that is exactly how
 *      `routes/transcriptions/tags.js` once stayed "written, tested and never mounted" with 39 green
 *      tests. Hence the block at the bottom, which calls the composed router from routes/webpages.js:
 *      if `router.use(require('./webpagesUsage'))` goes missing, this turns red instead of the tab
 *      quietly falling back to its empty state (`hooks/useUsage.js` turns a 404 into `usage: []`).
 *   4. WHAT goes into the scan. The stub below makes it easy to test only the output; the input
 *      counts just as much. `usageForWebpage` reads `projectId` from the PAGE ROW, so a route that
 *      only passes the id lets scanSolution report "checked, zero rows" about a page that DOES lie in
 *      a Solution — a real dependency that disappears as a confirmed zero instead of as a gap.
 *
 * Run: cd server && node --test --test-reporter=tap routes/webpagesUsage.test.js
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
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

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
    app.use(terminalErrorHandler);
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
        assert.strictEqual(body.error, 'Internal server error');
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
        assert.strictEqual(body.error, 'Internal server error');
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

// ── the mounting ────────────────────────────────────────────────────
//
// Everything above runs the sub-router on its own. This block runs the router that the app
// actually mounts, so that a missing `router.use(...)` fails here and not only on the screen.

const webpagesRouter = require('./webpages');

async function withComposedServer(t, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...OWNER } }; next(); });
    app.use(webpagesRouter);
    app.use(terminalErrorHandler);
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
    // The sub-router must stand BEFORE `GET /:id`. If it stands behind it, that handler reads "wp1" as
    // the id and "usage" as nothing, or worse: it answers with the page itself on a path that should
    // give a usage list.
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
