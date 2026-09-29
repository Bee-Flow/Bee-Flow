/**
 * Het adres: hoe het gemaakt wordt, en hoe het teruggevonden wordt.
 *
 * De harde eis staat in de kop van publicAddress.js: bij `unlisted` IS het
 * adres de sleutel, dus mag het niet uit de paginanaam te raden zijn. De
 * eerste tests hier bewaken precies dat; de rest bewaakt dat het adres niet
 * verspringt, dat het bij twijfel niets oplevert, en dat de wijzer naar de
 * canonieke share op share-id werkt en niet op pagina-id.
 *
 * db-stub vóór de require, zoals stores/webpage/bridgeGrants.test.js.
 *
 * Run: node --test --test-force-exit stores/webpage/publicAddress.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── db-stub ──────────────────────────────────────────────────────────
// Eén rij `webpages`, plus een verzameling bezette slugs zodat de unieke
// index nagebootst kan worden.
const OWNER = 'u1';
let row = null;              // { id, user_id, slug, public_share_id, name }
let takenSlugs = new Set();
let failNextUpdateWith = null;

const dbPath = require.resolve('../../db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        exec: async () => {},
        getOne: async (sql, params) => {
            if (/SELECT slug FROM webpages WHERE id = \$1 AND user_id = \$2/.test(sql)) {
                if (!row || row.id !== params[0] || row.user_id !== params[1]) return undefined;
                return { slug: row.slug };
            }
            if (/SELECT slug, public_share_id FROM webpages/.test(sql)) {
                if (!row || row.id !== params[0] || row.user_id !== params[1]) return undefined;
                return { slug: row.slug, public_share_id: row.public_share_id };
            }
            if (/SELECT id, user_id, public_share_id, name FROM webpages WHERE slug = \$1/.test(sql)) {
                if (!row || row.slug !== params[0]) return undefined;
                return { ...row };
            }
            return undefined;
        },
        run: async (sql, params) => {
            if (/UPDATE webpages SET slug = \$3/.test(sql)) {
                if (failNextUpdateWith) {
                    const e = new Error(`db said ${failNextUpdateWith}`); e.code = failNextUpdateWith;
                    failNextUpdateWith = null;
                    throw e;
                }
                if (!row || row.id !== params[0] || row.user_id !== params[1] || row.slug) return { rowCount: 0 };
                if (takenSlugs.has(params[2])) {
                    const e = new Error('duplicate key'); e.code = '23505';
                    throw e;
                }
                row.slug = params[2];
                takenSlugs.add(params[2]);
                return { rowCount: 1 };
            }
            if (/UPDATE webpages SET public_share_id = \$3/.test(sql)) {
                if (!row || row.id !== params[0] || row.user_id !== params[1]) return { rowCount: 0 };
                row.public_share_id = params[2];
                return { rowCount: 1 };
            }
            if (/UPDATE webpages SET public_share_id = NULL/.test(sql)) {
                if (!row || row.public_share_id !== params[0]) return { rowCount: 0 };
                row.public_share_id = null;
                return { rowCount: 1 };
            }
            return { rowCount: 0 };
        },
        getAll: async () => [],
    },
};
const schemaPath = require.resolve('./schema');
require.cache[schemaPath] = {
    id: schemaPath, filename: schemaPath, loaded: true,
    exports: { initDB: async () => {}, ready: Promise.resolve() },
};

const addr = require('./publicAddress');

function reset() {
    row = { id: 'wp1', user_id: OWNER, slug: null, public_share_id: null, name: 'Prijslijst 2026' };
    takenSlugs = new Set();
    failNextUpdateWith = null;
}

// ── de sleutel-eigenschap ────────────────────────────────────────────

test('een slug is NOOIT alleen de naam — er zit altijd entropie achter', () => {
    const s = addr.mintSlug('Prijslijst');
    assert.notStrictEqual(s, 'prijslijst', 'een raadbaar adres is bij unlisted een raadbaar wachtwoord');
    assert.match(s, /^prijslijst-[abcdefghijkmnpqrstuvwxyz23456789]{12}$/);
});

test('twee keer minten met dezelfde naam geeft twee verschillende adressen', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(addr.mintSlug('Offerte'));
    assert.strictEqual(seen.size, 200, 'het achtervoegsel moet echt willekeurig zijn');
});

test('een naam zonder bruikbare tekens levert alléén het achtervoegsel op, nooit leeg', () => {
    for (const naam of ['', '   ', '🐝🐝', '价目表', null, 42]) {
        const s = addr.mintSlug(naam);
        assert.match(s, /^[abcdefghijkmnpqrstuvwxyz23456789]{12}$/, `naam ${JSON.stringify(naam)}`);
    }
});

test('slugifyName strandt accenten op hun letter en gooit de rest weg', () => {
    assert.strictEqual(addr.slugifyName('Prijslijst café — 2026!'), 'prijslijst-cafe-2026');
    assert.strictEqual(addr.slugifyName('---'), '');
    assert.strictEqual(addr.slugifyName('a'.repeat(90)).length, 40, 'het leesbare deel is gecapt');
});

test('het achtervoegsel gebruikt geen tekens die verkeerd worden overgetypt', () => {
    const s = addr.randomSuffix();
    assert.strictEqual(s.length, 12);
    assert.ok(!/[l1o0]/.test(s), 'l/1 en o/0 horen niet in een adres dat mensen overtypen');
});

// ── het adres lezen ──────────────────────────────────────────────────

test('normalizeSlug accepteert alleen een echt adres', () => {
    assert.strictEqual(addr.normalizeSlug('Prijslijst-K3F9'), 'prijslijst-k3f9');
    assert.strictEqual(addr.normalizeSlug('  abc '), 'abc');
    for (const bad of ['a/b', 'a b', 'a_b', 'a.b', '../etc', "a'; drop", '', null, 'x'.repeat(129)]) {
        assert.strictEqual(addr.normalizeSlug(bad), '', `${JSON.stringify(bad)} is geen adres`);
    }
});

test('resolveSlug vindt niets bij een adres dat er net naast zit', async () => {
    reset();
    row.slug = 'prijslijst-k3f9x2mq7bd4';
    assert.ok(await addr.resolveSlug('prijslijst-k3f9x2mq7bd4'));
    assert.strictEqual(await addr.resolveSlug('prijslijst'), null, 'geen prefix-match');
    assert.strictEqual(await addr.resolveSlug('prijslijst-k3f9x2mq7bd'), null);
    assert.strictEqual(await addr.resolveSlug('%'), null);
});

test('resolveSlug geeft de wijzer terug, ook als die nergens heen wijst', async () => {
    reset();
    row.slug = 'x-abcdefghjkmn';
    const found = await addr.resolveSlug('x-abcdefghjkmn');
    assert.deepStrictEqual(found, { webpageId: 'wp1', ownerId: OWNER, publicShareId: null, name: 'Prijslijst 2026' });
});

// ── het adres zetten ─────────────────────────────────────────────────

test('ensureSlug is idempotent: een bestaand adres verspringt niet', async () => {
    reset();
    const first = await addr.ensureSlug('wp1', OWNER, 'Prijslijst 2026');
    const second = await addr.ensureSlug('wp1', OWNER, 'Heel andere naam');
    assert.strictEqual(second, first, 'openbaar uit- en weer aanzetten mag een gedeelde link niet breken');
});

test('ensureSlug raakt de pagina van een ander niet aan', async () => {
    reset();
    assert.strictEqual(await addr.ensureSlug('wp1', 'iemand-anders', 'x'), null);
    assert.strictEqual(row.slug, null);
});

test('een botsing op de unieke index wordt opnieuw geprobeerd, niet genegeerd', async () => {
    reset();
    // De eerste UPDATE botst (23505); de tweede poging moet gewoon slagen.
    failNextUpdateWith = '23505';
    const slug = await addr.ensureSlug('wp1', OWNER, 'Prijslijst');
    assert.ok(slug, 'na een botsing moet er alsnog een adres komen');
    assert.strictEqual(row.slug, slug);
});

test('een databasefout die GEEN botsing is, gaat door — nooit stil "adres gezet"', async () => {
    reset();
    failNextUpdateWith = '57014';   // query_canceled
    await assert.rejects(() => addr.ensureSlug('wp1', OWNER, 'Prijslijst'), /db said 57014/);
    assert.strictEqual(row.slug, null, 'een afgebroken UPDATE mag geen adres achterlaten');
});

// ── de wijzer naar de canonieke share ────────────────────────────────

test('setCanonicalShare zet en wist de wijzer, eigenaar-gescoopt', async () => {
    reset();
    assert.strictEqual(await addr.setCanonicalShare('wp1', OWNER, 'sh1'), true);
    assert.strictEqual(row.public_share_id, 'sh1');
    assert.strictEqual(await addr.setCanonicalShare('wp1', 'vreemde', 'sh2'), false);
    assert.strictEqual(row.public_share_id, 'sh1', 'een vreemde verzet het adres niet');
    await addr.setCanonicalShare('wp1', OWNER, null);
    assert.strictEqual(row.public_share_id, null);
});

test('clearCanonicalShare werkt op SHARE-id, dus een losse share raakt het adres niet', async () => {
    reset();
    await addr.setCanonicalShare('wp1', OWNER, 'sh_canoniek');
    assert.strictEqual(await addr.clearCanonicalShare('sh_los'), false);
    assert.strictEqual(row.public_share_id, 'sh_canoniek',
        'het intrekken van een derde losse link mag het adres niet meenemen');
    assert.strictEqual(await addr.clearCanonicalShare('sh_canoniek'), true);
    assert.strictEqual(row.public_share_id, null);
});

test('de slug blijft staan als de wijzer weggaat', async () => {
    reset();
    const slug = await addr.ensureSlug('wp1', OWNER, 'Prijslijst');
    await addr.setCanonicalShare('wp1', OWNER, 'sh1');
    await addr.clearCanonicalShare('sh1');
    assert.strictEqual(row.slug, slug, 'het adres overleeft het uitzetten van openbaar');
});
