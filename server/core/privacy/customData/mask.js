'use strict';
/**
 * Keyed, shape-preserving look-alikes of an admin's real examples.
 *
 * The test-bench assistant runs OUTSIDE the Privacy Shield: it is an ordinary
 * model call. It may therefore never see a real example ("KL-12345"), only a
 * look-alike with the same shape ("KL-83920"). The server keeps the pairing
 * and swaps the real values back into whatever the assistant writes.
 *
 * How a look-alike is drawn:
 *   - a byte stream from HMAC-SHA256(key, orgId ‖ 0 ‖ typeId ‖ 0 ‖ value ‖ 0 ‖ counter),
 *     extended block by block when a value needs more than 32 bytes;
 *   - the key is HKDF-SHA256(MASTER_ENCRYPTION_KEY, salt = orgId,
 *     info = 'beeflow:custom-data-mask:v1', 32 bytes): stable per org, so the
 *     preview and the send agree, and useless for any other org;
 *   - per code point: a decimal digit becomes a random ASCII digit other than
 *     itself; an upper-case letter a random A-Z other than its ASCII fold
 *     (É folds to E); a lower-case letter likewise in a-z; any other letter a
 *     random a-z (A-Z for title case); everything else (punctuation, spaces,
 *     symbols) is kept, as is every character inside a `keepFixed` part.
 *
 * So a look-alike has the same number of code points and the same class at
 * every position, and differs from its original whenever the original has
 * anything maskable. Within one set, no two look-alikes are equal, none equals
 * or contains a real example (case-insensitive; a real example of fewer than
 * 3 characters only has to differ), and a collision is re-drawn with the next
 * counter. An example with nothing maskable left cannot be disguised; it gets
 * no look-alike and is never sent.
 *
 * `keepFixed` is for pattern types only: a shared prefix or suffix such as
 * "KL-" that is part of the format rather than of the value. It holds at most
 * 4 letters and no digits, so it can never carry a whole real value.
 */

const crypto = require('node:crypto');

const MASK_INFO = 'beeflow:custom-data-mask:v1';
const MAX_REDRAWS = 64;
const DIGITS = '0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const KEEP_FIXED_MAX_CHARS = 8;
const KEEP_FIXED_MAX_LETTERS = 4;
const KEEP_FIXED_MAX_ITEMS = 2;

/**
 * The per-org mask key. Tests inject their own key instead.
 * @returns {Buffer}
 */
function maskKeyFor(orgId, { master = process.env.MASTER_ENCRYPTION_KEY } = {}) {
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY is required to prepare look-alikes');
    return Buffer.from(crypto.hkdfSync('sha256', String(master), String(orgId || ''), MASK_INFO, 32));
}

/** A deterministic byte stream: block 0 is the HMAC itself, later blocks append their index. */
function byteStream(key, message) {
    let block = crypto.createHmac('sha256', key).update(message).digest();
    let blockIndex = 0;
    let pos = 0;
    return function nextByte() {
        if (pos >= block.length) {
            blockIndex += 1;
            block = crypto.createHmac('sha256', key).update(`${message}\u0000${blockIndex}`).digest();
            pos = 0;
        }
        const b = block[pos];
        pos += 1;
        return b;
    };
}

/** Uniform pick from `alphabet` minus `exclude`, by rejection sampling on the stream. */
function pick(nextByte, alphabet, exclude) {
    const choices = exclude && alphabet.includes(exclude) ? alphabet.replace(exclude, '') : alphabet;
    const n = choices.length;
    const limit = Math.floor(256 / n) * n;
    for (;;) {
        const b = nextByte();
        if (b < limit) return choices[b % n];
    }
}

/** ASCII fold of one letter: strip diacritics, keep a single A-Z/a-z or nothing. */
function asciiFold(ch) {
    const base = ch.normalize('NFD').replace(/\p{M}+/gu, '');
    return /^[A-Za-z]$/.test(base) ? base : '';
}

/** Code-unit ranges of every occurrence of each keepFixed part in `value`. */
function fixedRanges(value, keepFixed) {
    const ranges = [];
    for (const part of Array.isArray(keepFixed) ? keepFixed : []) {
        if (typeof part !== 'string' || !part) continue;
        let from = 0;
        for (;;) {
            const at = value.indexOf(part, from);
            if (at === -1) break;
            ranges.push([at, at + part.length]);
            from = at + part.length;
        }
    }
    return ranges;
}

/** Is there anything in `value` (outside keepFixed) that masking changes? */
function hasMaskable(value, keepFixed) {
    const ranges = fixedRanges(value, keepFixed);
    let unit = 0;
    for (const ch of value) {
        const inFixed = ranges.some(([s, e]) => unit >= s && unit < e);
        unit += ch.length;
        if (!inFixed && /[\p{Nd}\p{L}]/u.test(ch)) return true;
    }
    return false;
}

/**
 * One look-alike for one value. Pure given (key, orgId, typeId, value, counter).
 * Returns the value unchanged when nothing in it is maskable.
 */
function maskExample(value, { key, orgId, typeId, keepFixed = [], counter = 0 }) {
    const str = String(value ?? '');
    const nextByte = byteStream(key, `${orgId ?? ''}\u0000${typeId ?? ''}\u0000${str}\u0000${counter}`);
    const ranges = fixedRanges(str, keepFixed);
    let out = '';
    let unit = 0;
    for (const ch of str) {
        const inFixed = ranges.some(([s, e]) => unit >= s && unit < e);
        unit += ch.length;
        if (inFixed) { out += ch; continue; }
        if (/\p{Nd}/u.test(ch)) {
            out += pick(nextByte, DIGITS, /[0-9]/.test(ch) ? ch : '');
        } else if (/\p{Lu}/u.test(ch)) {
            out += pick(nextByte, UPPER, asciiFold(ch).toUpperCase());
        } else if (/\p{Ll}/u.test(ch)) {
            out += pick(nextByte, LOWER, asciiFold(ch).toLowerCase());
        } else if (/\p{Lt}/u.test(ch)) {
            out += pick(nextByte, UPPER, asciiFold(ch).toUpperCase());
        } else if (/\p{L}/u.test(ch)) {
            out += pick(nextByte, LOWER, asciiFold(ch).toLowerCase());
        } else {
            out += ch;
        }
    }
    return out;
}

const cpLength = (s) => Array.from(s).length;

/**
 * Look-alikes for a whole example set, collision-free (see the header).
 * @returns {Array<{ example: string, lookalike: string|null }>} in input order;
 *   lookalike null when the example cannot be disguised.
 */
function maskExamples(examples, { key, orgId, typeId, keepFixed = [] }) {
    const list = (Array.isArray(examples) ? examples : []).map((e) => String(e));
    const lowerExamples = list.map((e) => e.toLowerCase());
    const taken = new Set();
    const clashes = (candidate) => {
        const low = candidate.toLowerCase();
        if (taken.has(low)) return true;
        for (let i = 0; i < list.length; i += 1) {
            const ex = lowerExamples[i];
            if (!ex) continue;
            if (cpLength(list[i]) >= 3 ? low.includes(ex) : low === ex) return true;
        }
        return false;
    };
    return list.map((example) => {
        if (!hasMaskable(example, keepFixed)) return { example, lookalike: null };
        for (let counter = 0; counter < MAX_REDRAWS; counter += 1) {
            const candidate = maskExample(example, { key, orgId, typeId, keepFixed, counter });
            if (!clashes(candidate)) {
                taken.add(candidate.toLowerCase());
                return { example, lookalike: candidate };
            }
        }
        return { example, lookalike: null };
    });
}

const LETTER_RX = /\p{L}/gu;
const FIXED_CHAR_RX = /^[\p{L}\p{P}\p{S}\p{Zs}]+$/u;

function letterCount(s) {
    return (s.match(LETTER_RX) || []).length;
}

/** The shape rule every keepFixed part obeys, proposed or sent. */
function keepFixedShapeOk(part) {
    return typeof part === 'string'
        && part.length >= 1 && part.length <= KEEP_FIXED_MAX_CHARS
        && FIXED_CHAR_RX.test(part)
        && letterCount(part) >= 1 && letterCount(part) <= KEEP_FIXED_MAX_LETTERS;
}

function commonPrefix(values) {
    const cps = values.map((v) => Array.from(v));
    const out = [];
    for (let i = 0; ; i += 1) {
        const ch = cps[0][i];
        if (ch === undefined || cps.some((c) => c[i] !== ch)) break;
        out.push(ch);
    }
    return out;
}

/** The leading run of letters/punctuation/symbols of a code-point list. */
function formatRun(cps) {
    const run = [];
    for (const ch of cps) {
        if (!/[\p{L}\p{P}\p{S}]/u.test(ch)) break;
        run.push(ch);
    }
    return run.join('');
}

/**
 * The server's keepFixed proposal: only for pattern types with at least two
 * examples, the shared letter/punctuation prefix and/or suffix of ALL
 * examples, when it has at most 4 letters and leaves something to mask.
 */
function proposeKeepFixed(examples, method) {
    if (method !== 'pattern') return [];
    const list = (Array.isArray(examples) ? examples : []).filter((e) => typeof e === 'string' && e);
    if (list.length < 2) return [];
    const out = [];
    const prefix = formatRun(commonPrefix(list));
    const reversed = list.map((e) => Array.from(e).reverse().join(''));
    const suffix = Array.from(formatRun(commonPrefix(reversed))).reverse().join('');
    for (const part of [prefix, suffix]) {
        if (!keepFixedShapeOk(part) || out.includes(part)) continue;
        if (list.some((e) => !hasMaskable(e, [part]))) continue;
        out.push(part);
    }
    return out;
}

/**
 * The keepFixed parts that are actually applied: pattern types only, the
 * shape rule, a prefix or suffix of at least two examples, never a whole
 * example, at most two. Anything else is ignored rather than refused: the
 * preview shows exactly what is sent, so an ignored part is visible there.
 */
function acceptedKeepFixed(keepFixed, examples, method) {
    if (method !== 'pattern' || !Array.isArray(keepFixed)) return [];
    const list = (Array.isArray(examples) ? examples : []).filter((e) => typeof e === 'string' && e);
    const out = [];
    for (const part of keepFixed) {
        if (out.length >= KEEP_FIXED_MAX_ITEMS) break;
        if (!keepFixedShapeOk(part) || out.includes(part)) continue;
        const sharing = list.filter((e) => e !== part && (e.startsWith(part) || e.endsWith(part))).length;
        if (sharing < 2 || list.includes(part)) continue;
        out.push(part);
    }
    return out;
}

module.exports = {
    MASK_INFO,
    maskKeyFor,
    maskExample,
    maskExamples,
    hasMaskable,
    proposeKeepFixed,
    acceptedKeepFixed,
    keepFixedShapeOk,
};
