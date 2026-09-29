/**
 * routes/webpages — de verwijderpoort (W5 deel C).
 *
 * Drie uitkomsten, en ze moeten uit elkaar blijven:
 *
 *   GEBLOKKEERD DOOR GEBRUIK        er is iets gevonden → 409 met de lijst.
 *   GEBLOKKEERD DOOR ONLEESBAARHEID er is NIETS gevonden en ook niets
 *                                   uitgesloten → óók 409, maar met een lege
 *                                   lijst en gevulde `unchecked`. Dit is de
 *                                   stand die het makkelijkst stilletjes
 *                                   verdwijnt: een lege `usage` zonder
 *                                   `unchecked` leest als "niets gebruikt dit"
 *                                   en dat is precies de zin waarop iemand
 *                                   doorklikt.
 *   VRIJ                            gecontroleerd én leeg → de verwijdering
 *                                   loopt door, inclusief de purge van de
 *                                   usage-index.
 *
 * Plus de ontsnappingsklep: `?confirm=1` is een BEVESTIGDE tweede aanroep en
 * moet de scan overslaan — niet stilletjes nóg een keer draaien.
 *
 * Geen database: auth is gestubd vóór de router laadt en elke store-aanraking
 * is gemonkeypatcht — hetzelfde patroon als routes/webpages.publish.test.js.
 *
 * Draaien: cd server && node --test --test-reporter=tap routes/webpages.delete.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

const perms = require('../auth/permissions');
perms.requireAuth = (req, res, next) => next();
const auth = require('../auth');
auth.requireActiveOrgForMutations = () => (req, res, next) => next();

const webpageStore = require('../stores/webpageStore');
const webpageDbStore = require('../stores/webpageDbStore');
const webpageUsage = require('../core/webpages/webpageUsage');
const webpageUsageSync = require('../core/webpages/webpageUsageSync');

const webpagesRouter = require('./webpages');

const OWNER = { id: 'alice', organizationId: 'org1' };

const PAGE = Object.freeze({
    id: 'wp1', userId: 'alice', name: 'Prijslijst',
    organizationId: 'org1', projectId: 'proj-1',
});

const SOLUTION_ROW = Object.freeze({
    kind: 'solution', id: 'proj-1', title: 'Offertes', role: 'contains',
    ownerId: 'alice', lastAt: null,
});

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => { for (const [obj, key, orig] of originals) obj[key] = orig; });
}

async function withServer(t, fn) {
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

/** De stores die het verwijderpad aanraakt, met een boekhouding van wat er gebeurde. */
function storePatches(calls, over = {}) {
    return [
        [webpageStore, 'getWebpage', async (id, userId) => (userId === PAGE.userId ? { ...PAGE } : null)],
        [webpageDbStore, 'invalidate', async (id) => { calls.order.push(`invalidate:${id}`); }],
        [webpageStore, 'deleteWebpage', async (id, userId) => {
            calls.order.push(`delete:${id}`);
            calls.deleted.push({ id, userId });
            return { ...PAGE, knowledgeBaseIds: [] };
        }],
        [webpageUsageSync, 'purgeWebpageUsage', async (id) => { calls.order.push(`purge:${id}`); }],
        ...Object.entries(over).map(([k, v]) => [webpageStore, k, v]),
    ];
}

const newCalls = () => ({ order: [], deleted: [] });

/** Wat `usageForWebpage` teruggeeft — de vier velden, met vrije standen. */
const scan = (over = {}) => ({ rows: [], partial: [], sources: {}, complete: true, ...over });

const del = (base, query = '') => fetch(`${base}/wp1${query}`, { method: 'DELETE' });

// ── geblokkeerd door gebruik ────────────────────────────────────────

test('409: iets gebruikt de pagina nog — de lijst reist mee en er wordt niets verwijderd', async () => {
    const calls = newCalls();
    await withPatches([
        ...storePatches(calls),
        [webpageUsage, 'usageForWebpage', async () => scan({
            rows: [{ ...SOLUTION_ROW }],
            sources: { solution: { status: 'checked', found: 1 } },
        })],
    ], () => withServer(test, async (base) => {
        const res = await del(base);
        assert.strictEqual(res.status, 409);
        const body = await res.json();

        assert.strictEqual(body.code, 'in_use', 'de code die shared/DangerZone.inUsePayload leest');
        assert.strictEqual(body.error, 'This webpage is still in use');
        assert.strictEqual(body.usage.length, 1);
        assert.strictEqual(body.usage[0].kind, 'solution');
        assert.strictEqual(body.usage[0].title, 'Offertes');
        assert.deepStrictEqual(body.unchecked, []);

        assert.deepStrictEqual(calls.order, [],
            'een geweigerde verwijdering mag niets aanraken — geen invalidate, geen delete, geen purge');
    }));
});

test('409: andermans Oplossing blokkeert wél, maar zonder haar naam', async () => {
    const calls = newCalls();
    await withPatches([
        ...storePatches(calls),
        [webpageUsage, 'usageForWebpage', async () => scan({
            rows: [{ ...SOLUTION_ROW, id: 'proj-9', title: 'Overname Acme', ownerId: 'someone-else' }],
        })],
    ], () => withServer(test, async (base) => {
        const res = await del(base);
        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.usage[0].title, null);
        assert.strictEqual(body.usage[0].foreign, true);
        assert.strictEqual(body.usage[0].role, 'contains', 'wat er stukgaat blijft leesbaar');
    }));
});

// ── geblokkeerd door onleesbaarheid ─────────────────────────────────

test('409: niets gevonden maar ook niets gecontroleerd blokkeert, met een ANDERE zin', async () => {
    const calls = newCalls();
    await withPatches([
        ...storePatches(calls),
        [webpageUsage, 'usageForWebpage', async () => scan({
            rows: [],
            partial: ['agent'],
            sources: {
                solution: { status: 'checked', found: 0 },
                chat: { status: 'checked', found: 0 },
                agent: { status: 'unavailable', found: null, reason: 'not-recorded' },
            },
            complete: false,
        })],
    ], () => withServer(test, async (base) => {
        const res = await del(base);
        assert.strictEqual(res.status, 409, 'niet-gecontroleerd telt als in gebruik');
        const body = await res.json();

        assert.strictEqual(body.error, 'Could not check what uses this webpage',
            '"wordt nog gebruikt" en "ik kon het niet controleren" zijn verschillende antwoorden');
        assert.deepStrictEqual(body.usage, []);
        assert.deepStrictEqual(body.unchecked, ['agent']);
        assert.strictEqual(body.sources.agent.found, null, '"niet gekeken" is geen getal');
        assert.strictEqual(body.complete, false);
        assert.deepStrictEqual(calls.order, []);
    }));
});

test('409: een scan die zelf omvalt meldt ALLE soorten als niet gecontroleerd', async () => {
    const calls = newCalls();
    await withPatches([
        ...storePatches(calls),
        [webpageUsage, 'usageForWebpage', async () => { throw new Error('scan exploded'); }],
    ], () => withServer(test, async (base) => {
        const res = await del(base);
        assert.strictEqual(res.status, 409, 'een omgevallen scan mag nooit als "niets gebruikt dit" doorgaan');
        const body = await res.json();

        assert.deepStrictEqual(body.usage, []);
        assert.deepStrictEqual(body.unchecked, [...webpageUsage.KINDS],
            'onbekend versmalt: elke soort onbeantwoord, niet nul');
        for (const kind of webpageUsage.KINDS) {
            assert.strictEqual(body.sources[kind].found, null);
            assert.strictEqual(body.sources[kind].reason, webpageUsage.REASONS.SCAN_FAILED);
        }
        assert.strictEqual(body.complete, false);
        assert.deepStrictEqual(calls.order, []);
    }));
});

// ── vrij ────────────────────────────────────────────────────────────

test('gecontroleerd én leeg: de verwijdering loopt door en ruimt de usage-index op', async () => {
    const calls = newCalls();
    await withPatches([
        ...storePatches(calls),
        [webpageUsage, 'usageForWebpage', async () => scan({
            sources: {
                solution: { status: 'checked', found: 0 },
                chat: { status: 'checked', found: 0 },
                agent: { status: 'checked', found: 0 },
            },
        })],
    ], () => withServer(test, async (base) => {
        const res = await del(base);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { success: true });

        assert.deepStrictEqual(calls.order, ['invalidate:wp1', 'delete:wp1', 'purge:wp1']);
        assert.deepStrictEqual(calls.deleted, [{ id: 'wp1', userId: 'alice' }]);
    }));
});

// ── de bevestigde tweede aanroep ────────────────────────────────────

test('?confirm=1 slaat de scan over en verwijdert', async () => {
    const calls = newCalls();
    let scanned = 0;
    await withPatches([
        ...storePatches(calls),
        [webpageUsage, 'usageForWebpage', async () => { scanned += 1; return scan({ rows: [{ ...SOLUTION_ROW }] }); }],
    ], () => withServer(test, async (base) => {
        const res = await del(base, '?confirm=1');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(scanned, 0, 'de bevestiging is het antwoord op de scan, geen aanleiding voor een tweede');
        assert.deepStrictEqual(calls.order, ['invalidate:wp1', 'delete:wp1', 'purge:wp1']);
    }));
});

test('een niet-eigenaar krijgt 404 en de scan draait niet', async () => {
    const calls = newCalls();
    let scanned = 0;
    await withPatches([
        ...storePatches(calls, { getWebpage: async () => null }),
        [webpageUsage, 'usageForWebpage', async () => { scanned += 1; return scan(); }],
    ], () => withServer(test, async (base) => {
        const res = await del(base);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(scanned, 0,
            'een niet-eigenaar mag niet leren in welke Oplossing de pagina ligt');
        assert.deepStrictEqual(calls.order, []);
    }));
});
