// @typecheck
/**
 * Het ADRES van een openbare pagina, en welke share dat adres bedient.
 *
 * Twee kolommen op `webpages`, allebei NULL zolang de pagina nooit openbaar is
 * geweest:
 *
 *   slug             /w/<slug> — waar de pagina staat. Uniek per instantie.
 *   public_share_id  WELKE van de shares dat adres bedient — "één share is
 *                    het adres". Het N-share-model blijft gewoon bestaan
 *                    (webpage_public_shares houdt er zoveel als de eigenaar
 *                    maakt, elk met zijn eigen /share/<token>); deze wijzer
 *                    zegt alleen welke daarvan DE canonieke is.
 *
 * ── DE SLUG IS EEN SLEUTEL, GEEN LABEL ──────────────────────────────
 *
 * Dit is het punt waar deze module het makkelijk had kunnen verpesten. Bij
 * toegangsmodus `unlisted` is het adres het ENIGE dat een bezoeker hoeft te
 * weten: wie de URL heeft, ziet de pagina. Een slug die puur uit de naam komt
 * (`/w/prijslijst`, `/w/offerte`, `/w/personeelshandboek`) is dus geen adres
 * maar een raadbaar wachtwoord, en één scriptje met een woordenlijst somt
 * daarmee elke openbare pagina op de installatie op.
 *
 * Daarom is een slug hier ALTIJD "leesbaar deel + willekeurig achtervoegsel":
 *
 *     prijslijst-k3f9x2mq7bd4
 *     ^^^^^^^^^^ ^^^^^^^^^^^^
 *     uit de naam  60 bits uit crypto.randomBytes
 *
 * Het leesbare deel is er voor de mens die de link deelt; het achtervoegsel is
 * er zodat de link niet te raden valt. Een leeg leesbaar deel (naam bestaat uit
 * emoji, Chinees, of niets) levert gewoon alléén het achtervoegsel op — nooit
 * een lege of voorspelbare slug.
 *
 * ── ALLES VERSMALT ──────────────────────────────────────────────────
 *
 *   - `resolveSlug` geeft de rij ALLEEN terug op een exacte, genormaliseerde
 *     match. Geen ILIKE, geen prefix, geen "bijna goed".
 *   - `ensureSlug` mint hoogstens `MINT_ATTEMPTS` keer; lukt het dan nog niet,
 *     dan gooit hij. Een pagina zonder adres is beter dan twee pagina's op
 *     hetzelfde adres.
 *   - de wijzer is ZACHT: wijst hij naar een ingetrokken of verdwenen share,
 *     dan is dat een 404 bij de bezoeker, geen databasefout. De liveness-toets
 *     hoort bij de share (webpagePublicShareStore.findLiveShareById), niet hier.
 */

'use strict';

const crypto = require('crypto');
const { run, getOne } = require('../../db');
const { initDB } = require('./schema');

/**
 * Alfabet van het willekeurige achtervoegsel: kleine letters en cijfers zonder
 * de paren die in een gedeelde link verkeerd worden overgetypt (l/1, o/0).
 * 32 tekens = precies 5 bits per teken.
 */
const SUFFIX_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
/** 12 tekens × 5 bits = 60 bits. Ruim voorbij raadbaar, kort genoeg om te delen. */
const SUFFIX_LENGTH = 12;
/** Hoeveel tekens van de naam we in het adres laten meelopen. */
const MAX_READABLE = 40;
/** Hoe vaak we een botsing op de unieke index opnieuw proberen. */
const MINT_ATTEMPTS = 5;

/**
 * Het leesbare deel: kleine letters, cijfers en koppeltekens, verder niets.
 *
 * Bewust ASCII-only. Een slug met accenten of Cyrillisch overleeft het knippen
 * en plakken door een e-mailclient niet ongeschonden, en een adres dat
 * onderweg verandert is geen adres. Levert '' op als er niets bruikbaars
 * overblijft — de aanroeper vult dan alleen het achtervoegsel in.
 */
function slugifyName(name) {
    if (typeof name !== 'string') return '';
    return name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')   // accenten weg, letter blijft
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_READABLE)
        .replace(/-+$/g, '');
}

/** `SUFFIX_LENGTH` tekens uit crypto.randomBytes, gelijkmatig over het alfabet. */
function randomSuffix(bytes = null) {
    // 32 is een deler van 256, dus `% 32` op een willekeurige byte is
    // gelijkverdeeld — geen modulo-bias, geen verwerpingslus nodig.
    const buf = bytes || crypto.randomBytes(SUFFIX_LENGTH);
    let out = '';
    for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
        out += SUFFIX_ALPHABET[buf[i % buf.length] % SUFFIX_ALPHABET.length];
    }
    return out;
}

/**
 * Het volledige adres-deel voor een pagina met deze naam.
 * ALTIJD met achtervoegsel — er bestaat geen aanroep die een kale naam-slug
 * oplevert, want die zou raadbaar zijn.
 */
function mintSlug(name, { bytes = null } = {}) {
    const readable = slugifyName(name);
    const suffix = randomSuffix(bytes);
    return readable ? `${readable}-${suffix}` : suffix;
}

/**
 * Hoe een adres uit een URL wordt gelezen. Zelfde normalisatie als bij het
 * minten, zodat `/w/Prijslijst-K3F9…` dezelfde rij vindt als `/w/prijslijst-k3f9…`
 * en een adres met rommel eromheen niets vindt in plaats van bijna-iets.
 */
function normalizeSlug(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().toLowerCase();
    if (!s || s.length > 128) return '';
    return /^[a-z0-9-]+$/.test(s) ? s : '';
}

// ── I/O ──────────────────────────────────────────────────────────────

/**
 * Geef deze pagina een adres, of geef het bestaande terug.
 *
 * Idempotent: een pagina die al een slug heeft, houdt hem. Dat is met opzet —
 * openbaar uitzetten en later weer aanzetten mag een gedeelde link niet
 * ongeldig maken, en een adres dat verspringt is precies wat mensen niet
 * verwachten van "het adres".
 *
 * De UPDATE is eigenaar-gescoped én zet alleen als er nog niets staat
 * (`slug IS NULL`), zodat twee gelijktijdige aanroepen niet elkaars adres
 * overschrijven: de tweede raakt 0 rijen en leest daarna het adres van de
 * eerste.
 */
async function ensureSlug(webpageId, ownerId, name) {
    await initDB();
    if (!webpageId || !ownerId) return null;

    const existing = await getOne(
        `SELECT slug FROM webpages WHERE id = $1 AND user_id = $2`,
        [webpageId, ownerId],
    );
    if (!existing) return null;                       // pagina bestaat niet / niet van hem
    if (existing.slug) return existing.slug;

    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
        const candidate = mintSlug(name);
        try {
            const { rowCount } = await run(
                `UPDATE webpages SET slug = $3, updated_at = NOW()
                  WHERE id = $1 AND user_id = $2 AND slug IS NULL`,
                [webpageId, ownerId, candidate],
            );
            if (rowCount > 0) return candidate;
        } catch (e) {
            // 23505 = unieke index. Alles anders is niet van ons: doorgooien,
            // nooit stil doorlopen alsof het adres gezet is.
            if (e.code !== '23505') throw e;
        }
        // 0 rijen of een botsing: iemand anders was eerder, of het adres was
        // al bezet. Opnieuw lezen — misschien staat er nu gewoon een slug.
        const again = await getOne(
            `SELECT slug FROM webpages WHERE id = $1 AND user_id = $2`,
            [webpageId, ownerId],
        );
        if (again?.slug) return again.slug;
    }
    throw new Error('Could not mint a unique address for this page');
}

/**
 * Het adres → de pagina. Anoniem pad: GEEN gebruikersscope, want de bezoeker
 * heeft er geen. Geeft daarom ook alleen terug wat de viewer nodig heeft.
 */
async function resolveSlug(rawSlug) {
    await initDB();
    const slug = normalizeSlug(rawSlug);
    if (!slug) return null;
    const r = await getOne(
        `SELECT id, user_id, public_share_id, name FROM webpages WHERE slug = $1`,
        [slug],
    );
    if (!r) return null;
    return {
        webpageId: r.id,
        ownerId: r.user_id,
        publicShareId: r.public_share_id || null,
        name: r.name || '',
    };
}

/** Het adres van één pagina (eigenaar-gescoped), of null. */
async function getAddress(webpageId, ownerId) {
    await initDB();
    if (!webpageId || !ownerId) return null;
    const r = await getOne(
        `SELECT slug, public_share_id FROM webpages WHERE id = $1 AND user_id = $2`,
        [webpageId, ownerId],
    );
    if (!r) return null;
    return { slug: r.slug || null, publicShareId: r.public_share_id || null };
}

/**
 * Wijs het adres naar deze share — of naar niets (`null`), wat "niet openbaar"
 * betekent. De slug blijft dan staan; alleen de wijzer gaat weg.
 */
async function setCanonicalShare(webpageId, ownerId, shareId) {
    await initDB();
    if (!webpageId || !ownerId) return false;
    const { rowCount } = await run(
        `UPDATE webpages SET public_share_id = $3, updated_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [webpageId, ownerId, shareId || null],
    );
    return rowCount > 0;
}

/**
 * Trek de wijzer in zodra DEZE share verdwijnt (intrekken, verwijderen).
 *
 * Op share-id, niet op pagina-id: een eigenaar die zijn derde losse share
 * intrekt mag het adres niet kwijtraken. Raakt 0 rijen als de wijzer al ergens
 * anders heen wees — dat is de goede uitkomst, geen fout.
 */
async function clearCanonicalShare(shareId) {
    await initDB();
    if (!shareId) return false;
    const { rowCount } = await run(
        `UPDATE webpages SET public_share_id = NULL, updated_at = NOW()
          WHERE public_share_id = $1`,
        [shareId],
    );
    return rowCount > 0;
}

module.exports = {
    // puur
    slugifyName,
    randomSuffix,
    mintSlug,
    normalizeSlug,
    SUFFIX_ALPHABET,
    SUFFIX_LENGTH,
    // I/O
    ensureSlug,
    resolveSlug,
    getAddress,
    setCanonicalShare,
    clearCanonicalShare,
};
