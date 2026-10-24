// @typecheck
/**
 * /w/<slug> — the address of the PAGE, served by the same viewer.
 *
 * The gain of one router on two mounts is that the access control exists only once. The price is that the viewer now has to know under which mount
 * it runs, because everything it writes about itself — iframe src, form action, magic link, cookie path — depends on that. These tests guard both sides:
 *
 *   FAIL CLOSED  no pointer, a dead pointer, or a pointer to the share of a
 *                DIFFERENT page yields 404. Never "the address exists, so show it".
 *   NO LEAK      /share keeps doing exactly what it did; the new mount writes no /share
 *                links and vice versa.
 *
 * Run: node --test --test-force-exit routes/publicViewer.slug.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

const publicShareStore = require('../stores/webpagePublicShareStore');
const publicAddress = require('../stores/webpage/publicAddress');
const publicShareToken = require('../auth/publicShareToken');
const webpageSnapshot = require('../services/webpageSnapshot');
const userStore = require('../stores/userStore');
const viewer = require('./publicViewer');

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

async function withServer(t, fn) {
    const app = express();
    app.use('/share', viewer);
    app.use('/w', viewer);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

const LIVE_SHARE = {
    id: 'sh1', webpageId: 'wp1', createdBy: 'u1', accessMode: 'unlisted',
    title: 'Prijslijst', snapshotKind: 'static', organizationId: null,
};
const SLUG = 'prijslijst-k3f9x2mq7bd4';
const TOKEN = 'a'.repeat(40);

/** De stubs die elke test deelt. */
function base(over = {}) {
    return [
        [publicAddress, 'resolveSlug', over.resolveSlug
            || (async (s) => (s === SLUG ? { webpageId: 'wp1', ownerId: 'u1', publicShareId: 'sh1', name: 'Prijslijst' } : null))],
        [publicShareStore, 'findLiveShareById', over.findLiveShareById || (async (id) => (id === 'sh1' ? { ...LIVE_SHARE } : null))],
        [publicShareStore, 'findByToken', over.findByToken || (async (t) => (t === TOKEN ? { ...LIVE_SHARE } : null))],
        [publicShareStore, 'recordView', async () => {}],
        [userStore, 'getUser', async () => ({ name: 'Tom' })],
        [webpageSnapshot, 'readSnapshotSlot', over.readSnapshotSlot || (async (id, slot) => (slot === 'html' ? '<p>hoi</p>' : 'p{}'))],
    ];
}

// ── de gelukkige weg ─────────────────────────────────────────────────

test('/w/<slug> serveert de canonieke share', async () => {
    await withPatches(base(), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/w/${SLUG}`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.match(html, new RegExp(`src="/w/${SLUG}/content`),
            'de iframe moet onder DIT adres blijven — niet terugvallen op /share');
        assert.ok(!/\/share\//.test(html), 'op /w hoort geen enkele /share-link te staan');
    }));
});

test('/w/<slug>/content levert de snapshot met de extras-basis van dit adres', async () => {
    await withPatches(base(), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/w/${SLUG}/content`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.match(html, new RegExp(`<base href="/w/${SLUG}/extras/"`));
        assert.match(html, /hoi/);
    }));
});

test('a repeated ?v= is no view token and is never written back into the page', async () => {
    await withPatches(base({ readSnapshotSlot: async (id, slot) => (slot === 'html' ? '<img src="a.png">' : '') }),
        () => withServer(test, async (b) => {
            const res = await fetch(`${b}/w/${SLUG}/content?v=x&v=y`);
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(!/v=x/.test(html), 'an array ?v= must not be echoed as a token');
        }));
});

test('/share/<token> doet nog precies wat het deed', async () => {
    await withPatches(base(), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/share/${TOKEN}`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.match(html, new RegExp(`src="/share/${TOKEN}/content`));
        assert.ok(!/"\/w\//.test(html), 'de oude mount mag geen /w-links gaan uitschrijven');
    }));
});

// ── faal dicht ───────────────────────────────────────────────────────

test('een adres zonder wijzer is 404 — het bestaan van de slug zegt niets', async () => {
    let asked = false;
    await withPatches(base({
        resolveSlug: async () => ({ webpageId: 'wp1', ownerId: 'u1', publicShareId: null, name: 'x' }),
        findLiveShareById: async () => { asked = true; return { ...LIVE_SHARE }; },
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/w/${SLUG}`);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(asked, false, 'zonder wijzer valt er niets op te zoeken');
    }));
});

test('een wijzer naar een INGETROKKEN of verlopen share is 404', async () => {
    // findLiveShareById applies the same liveness gate as findByToken and
    // then returns null; the address may not build anything around that.
    await withPatches(base({ findLiveShareById: async () => null }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/w/${SLUG}`);
        assert.strictEqual(res.status, 404);
        assert.match(await res.text(), /not found|no longer/i);
    }));
});

test('een wijzer naar de share van een ANDERE pagina is 404', async () => {
    await withPatches(base({
        findLiveShareById: async () => ({ ...LIVE_SHARE, webpageId: 'wp_iemand_anders' }),
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/w/${SLUG}`);
        assert.strictEqual(res.status, 404,
            'een verkeerd gerichte wijzer mag nooit andermans bytes onder dit adres serveren');
    }));
});

test('een onbekend of misvormd adres is 404 zonder ooit een share op te zoeken', async () => {
    let asked = 0;
    await withPatches(base({
        resolveSlug: async () => null,
        findLiveShareById: async () => { asked += 1; return { ...LIVE_SHARE }; },
    }), () => withServer(test, async (b) => {
        for (const bad of ['bestaat-niet', 'x'.repeat(200), '%20']) {
            const res = await fetch(`${b}/w/${bad}`);
            assert.strictEqual(res.status, 404, bad);
        }
        assert.strictEqual(asked, 0);
    }));
});

// ── de poort zit op de share, niet op de mount ───────────────────────

test('een wachtwoord-share vraagt op /w net zo goed om het wachtwoord', async () => {
    await withPatches(base({
        findLiveShareById: async () => ({ ...LIVE_SHARE, accessMode: 'password', _passwordHash: 'x' }),
    }), () => withServer(test, async (b) => {
        const res = await fetch(`${b}/w/${SLUG}`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.match(html, /Enter password/);
        assert.match(html, new RegExp(`action="/w/${SLUG}/unlock"`),
            'het formulier moet naar DIT adres posten, anders zet de unlock een cookie op het verkeerde pad');
    }));
});

test('de unlock-cookie krijgt het pad van de mount waarop hij gezet wordt', async () => {
    await withPatches([
        ...base({ findLiveShareById: async () => ({ ...LIVE_SHARE, accessMode: 'password', _passwordHash: 'x' }) }),
        [publicShareToken, 'verifyCsrf', () => true],
        [publicShareStore, 'verifyPassword', async () => true],
    ], () => withServer(test, async (b) => {
        const res = await fetch(`${b}/w/${SLUG}/unlock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'password=geheim&_csrf=x',
            redirect: 'manual',
        });
        const cookie = res.headers.get('set-cookie') || '';
        assert.match(cookie, /Path=\/w/, 'een cookie met Path=/share wordt op /w nooit meegestuurd');
        assert.strictEqual(res.headers.get('location'), `/w/${SLUG}`);
    }));
});

// ── de bron zelf ─────────────────────────────────────────────────────

test('beide opzoekwegen delen ÉÉN liveness-toets', () => {
    // Deliberately source text: the other tests above stub findLiveShareById/
    // findByToken themselves in order to test the ROUTE, so calling the real functions for
    // THIS property would mean setting up webpagePublicShareStore.js with a fake ../db (and transitively configStore/storageStore/webpageStore) separately. The property itself ("update one place, no second
    // copy") is a DRY property of the code, not behaviour on an input — two functions that happen to react identically today do not prove that they share
    // the same gate instead of being two synchronised copies.
    const src = require('node:fs').readFileSync(require.resolve('../stores/webpagePublicShareStore'), 'utf8');
    assert.strictEqual((src.match(/if \(share\.revokedAt\) return null;/g) || []).length, 1,
        'twee kopieën van "ingetrokken?" is de plek waar er ooit één wordt bijgewerkt en de andere niet');
    assert.match(src, /function liveShareOrNull/);
    for (const fn of ['findByToken', 'findLiveShareById']) {
        const start = src.indexOf(`async function ${fn}`);
        const body = src.slice(start, src.indexOf('\n}', start));
        assert.match(body, /liveShareOrNull\(r\)/, `${fn} moet door dezelfde poort`);
    }
});
