// @typecheck strict
/**
 * The ADDRESS of a public page, and which share serves that address.
 *
 * Two columns on `webpages`, both NULL for as long as the page has never been public:
 *
 *   slug             /w/<slug> — where the page lives. Unique per instance.
 *   public_share_id  WHICH of the shares serves that address — "one share is the address". The
 *                    N-share model simply continues to exist (webpage_public_shares holds as many
 *                    as the owner makes, each with its own /share/<token>); this pointer only says
 *                    which of them is THE canonical one.
 *
 * ── THE SLUG IS A KEY, NOT A LABEL ──────────────────────────────────
 *
 * This is the point where this module could easily have ruined things. In access mode `unlisted`
 * the address is the ONLY thing a visitor needs to know: whoever has the URL sees the page. A slug
 * that comes purely from the name (`/w/prijslijst`, `/w/offerte`, `/w/personeelshandboek`) is
 * therefore not an address but a guessable password, and one little script with a word list would
 * enumerate every public page on the installation.
 *
 * That is why a slug here is ALWAYS "readable part + random suffix":
 *
 *     prijslijst-k3f9x2mq7bd4
 *     ^^^^^^^^^^ ^^^^^^^^^^^^
 *     from the name  60 bits from crypto.randomBytes
 *
 * The readable part is there for the human who shares the link; the suffix is there so that the
 * link cannot be guessed. An empty readable part (the name consists of emoji, Chinese or nothing)
 * simply yields the suffix alone — never an empty or predictable slug.
 *
 * ── EVERYTHING NARROWS ──────────────────────────────────────────────
 *
 *   - `resolveSlug` returns the row ONLY on an exact, normalised match. No ILIKE, no prefix,
 *     no "almost right".
 *   - `ensureSlug` mints at most `MINT_ATTEMPTS` times; if that still does not succeed, it throws.
 *     A page without an address is better than two pages at the same address.
 *   - the pointer is SOFT: if it points to a withdrawn or vanished share, that is a 404 for the
 *     visitor, not a database error. The liveness check belongs to the share
 *     (webpagePublicShareStore.findLiveShareById), not here.
 */

'use strict';

const crypto = require('crypto');
const { run, getOne } = require('../../db');
const { initDB } = require('./schema');

/**
 * Alphabet of the random suffix: lowercase letters and digits, without the pairs that are mistyped
 * in a shared link (l/1, o/0). 32 characters = exactly 5 bits per character.
 */
const SUFFIX_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
/** 12 tekens × 5 bits = 60 bits. Ruim voorbij raadbaar, kort genoeg om te delen. */
const SUFFIX_LENGTH = 12;
/** Hoeveel tekens van de naam we in het adres laten meelopen. */
const MAX_READABLE = 40;
/** Hoe vaak we een botsing op de unieke index opnieuw proberen. */
const MINT_ATTEMPTS = 5;

/**
 * The readable part: lowercase letters, digits and hyphens, nothing else.
 *
 * Deliberately ASCII-only. A slug with accents or Cyrillic does not survive being cut and pasted
 * through an e-mail client unscathed, and an address that changes on the way is not an address.
 * Yields '' if nothing usable remains — the caller then fills in only the suffix.
 * @param {string} name
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

/**
 * `SUFFIX_LENGTH` tekens uit crypto.randomBytes, gelijkmatig over het alfabet.
 * @param {Buffer | Uint8Array | null} [bytes]
 */
function randomSuffix(bytes = null) {
    // 32 is a divisor of 256, so `% 32` on a random byte is evenly distributed — no modulo bias,
    // no rejection loop needed.
    const buf = bytes || crypto.randomBytes(SUFFIX_LENGTH);
    let out = '';
    for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
        out += SUFFIX_ALPHABET[buf[i % buf.length] % SUFFIX_ALPHABET.length];
    }
    return out;
}

/**
 * The full address part for a page with this name.
 * ALWAYS with a suffix — there is no call that yields a bare name slug, because that would be guessable.
 * @param {string} name
 * @param {{ bytes?: Buffer | Uint8Array | null }} [opts]
 */
function mintSlug(name, { bytes = null } = {}) {
    const readable = slugifyName(name);
    const suffix = randomSuffix(bytes);
    return readable ? `${readable}-${suffix}` : suffix;
}

/**
 * How an address is read from a URL. The same normalisation as when minting, so that
 * `/w/Prijslijst-K3F9…` finds the same row as `/w/prijslijst-k3f9…`, and an address with junk
 * around it finds nothing instead of almost-something.
 * @param {unknown} raw
 */
function normalizeSlug(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().toLowerCase();
    if (!s || s.length > 128) return '';
    return /^[a-z0-9-]+$/.test(s) ? s : '';
}

// ── I/O ──────────────────────────────────────────────────────────────

/**
 * Give this page an address, or return the existing one.
 *
 * Idempotent: a page that already has a slug keeps it. That is deliberate — switching public off
 * and back on later must not invalidate a shared link, and an address that shifts is exactly what
 * people do not expect from "the address".
 *
 * The UPDATE is owner-scoped AND only sets when there is still nothing there (`slug IS NULL`), so
 * that two concurrent calls do not overwrite each other's address: the second touches 0 rows and
 * then reads the address of the first.
 * @param {string} webpageId
 * @param {string} ownerId
 * @param {string} name
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
            // 23505 = unique index. Anything else is not ours: pass it on, never silently carry on as if the
            // address had been set.
            if (e.code !== '23505') throw e;
        }
        // 0 rows or a collision: someone else was first, or the address was already taken. Read again —
        // there may now simply be a slug.
        const again = await getOne(
            `SELECT slug FROM webpages WHERE id = $1 AND user_id = $2`,
            [webpageId, ownerId],
        );
        if (again?.slug) return again.slug;
    }
    throw new Error('Could not mint a unique address for this page');
}

/**
 * The address → the page. Anonymous path: NO user scope, because the visitor has none. It therefore
 * also returns only what the viewer needs.
 * @param {unknown} rawSlug
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

/**
 * Het adres van één pagina (eigenaar-gescoped), of null.
 * @param {string} webpageId
 * @param {string} ownerId
 */
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
 * Point the address at this share — or at nothing (`null`), which means "not public". The slug stays;
 * only the pointer goes away.
 * @param {string} webpageId
 * @param {string} ownerId
 * @param {string} shareId
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
 * Withdraw the pointer as soon as THIS share disappears (withdrawn, deleted).
 *
 * On share id, not on page id: an owner who withdraws his third separate share must not lose the
 * address. Touches 0 rows if the pointer already pointed somewhere else — that is the good outcome,
 * not an error.
 * @param {string} shareId
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
