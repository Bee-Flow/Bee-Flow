/**
 * /w/<slug> — het adres van de PAGINA, bediend door dezelfde viewer.
 *
 * De winst van één router op twee mounts is dat de toegangscontrole maar één
 * keer bestaat. De prijs is dat de viewer nu moet weten onder welke mount hij
 * draait, want alles wat hij over zichzelf uitschrijft — iframe-src,
 * formulier-action, magic-link, cookiepad — hangt daaraan. Deze tests bewaken
 * allebei die kanten:
 *
 *   FAAL DICHT   geen wijzer, een dode wijzer, of een wijzer naar de share van
 *                een ANDERE pagina levert 404 op. Nooit "het adres bestaat dus
 *                laat maar zien".
 *   GEEN LEK     /share blijft precies doen wat het deed; de nieuwe mount
 *                schrijft geen /share-links uit en andersom.
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
    // findLiveShareById past dezelfde liveness-poort toe als findByToken en
    // geeft dan null; het adres mag daar niets omheen bouwen.
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
    // Bewust brontekst: de andere tests hierboven stubben findLiveShareById/
    // findByToken zelf weg om de ROUTE te testen, dus de échte functies
    // aanroepen voor DEZE eigenschap zou webpagePublicShareStore.js met een
    // nep-../db (en transitief configStore/storageStore/webpageStore) apart
    // moeten optuigen. De eigenschap zelf ("één plek bijwerken, geen tweede
    // kopie") is een DRY-eigenschap van de code, geen gedrag op een input —
    // twee functies die vandaag toevallig gelijk reageren bewijst niet dat ze
    // dezelfde poort delen in plaats van twee gesynchroniseerde kopieën.
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
