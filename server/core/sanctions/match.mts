/**
 * match.mts: how alike two names are, from 0 (nothing in common) to 1 (the same tokens).
 *
 * Both names arrive as token lists (normalize.mts nameTokens). Two views are taken and the
 * higher one wins (one word against a longer name stays at 0.8 or below, unless the listing is
 * an organisation and the word has five letters or more). Tokens with the same phoneticCode
 * (normalize.mts) score at least 0.92, and particles are also tried run together:
 *
 *   - run together: the tokens joined without spaces, compared with Jaro-Winkler, counted only
 *     when nearly identical ("AlZawahiri" and "Al Zawahiri");
 *   - token alignment, in any order: every token of the shorter name paired with its best
 *     partner in the longer one (Jaro-Winkler per token, an initial matches a token that starts
 *     with it, a pair below TOKEN_FLOOR counts as nothing), the length-weighted average of those
 *     pairs, lowered a little per token of the longer name nobody paired with. "Qusay
 *     Hussein" against "Qusay Saddam Hussein Al-Tikriti" scores well but not 1.
 *
 * Pure and synchronous: the screening scores a few hundred candidates per name.
 */

import { mergeParticles, phoneticCode } from './normalize.mts';

/** Which characters of `a` and `b` match within the Jaro window. */
function jaroHits(a: string, b: string): { aHit: boolean[]; bHit: boolean[]; matches: number } {
    const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aHit = new Array<boolean>(a.length).fill(false);
    const bHit = new Array<boolean>(b.length).fill(false);
    let matches = 0;
    for (let i = 0; i < a.length; i++) {
        const hi = Math.min(b.length - 1, i + range);
        for (let j = Math.max(0, i - range); j <= hi; j++) {
            if (bHit[j] || a[i] !== b[j]) continue;
            aHit[i] = true;
            bHit[j] = true;
            matches++;
            break;
        }
    }
    return { aHit, bHit, matches };
}

/** Half the number of matched characters that are out of order. */
function halfTranspositions(a: string, b: string, aHit: boolean[], bHit: boolean[]): number {
    let out = 0;
    let k = 0;
    for (let i = 0; i < a.length; i++) {
        if (!aHit[i]) continue;
        while (!bHit[k]) k++;
        if (a[i] !== b[k]) out++;
        k++;
    }
    return out / 2;
}

function commonPrefix(a: string, b: string, max: number): number {
    let n = 0;
    while (n < max && n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

/** Jaro-Winkler similarity of two strings (0..1), prefix scale 0.1 over at most 4 characters. */
export function jaroWinkler(a: string, b: string): number {
    if (a === b) return a.length ? 1 : 0;
    if (!a.length || !b.length) return 0;
    const { aHit, bHit, matches: m } = jaroHits(a, b);
    if (!m) return 0;
    const t = halfTranspositions(a, b, aHit, bHit);
    const jaro = (m / a.length + m / b.length + (m - t) / m) / 3;
    return jaro + commonPrefix(a, b, 4) * 0.1 * (1 - jaro);
}

/** One token against another: an initial ("m") counts as a fair match for a token it starts. */
export function tokenSimilarity(q: string, c: string): number {
    if (q === c) return 1;
    if (q.length === 1 || c.length === 1) return (q[0] === c[0]) ? 0.8 : 0;
    const jw = jaroWinkler(q, c);
    // Two transliterations of one name (Qadhafi / Gaddafi, Osman / Usman) share the phonetic
    // code; Jaro-Winkler alone puts them around 0.8. The floor on jw keeps an unrelated pair that
    // happens to share a short code (Hassan / Hussein, 0.77) where it was.
    if (jw >= PHONETIC_JW_FLOOR && q.length >= 3 && c.length >= 3 && phoneticCode(q) === phoneticCode(c)) return Math.max(jw, PHONETIC_SCORE);
    return jw;
}

/** What two tokens with the same phonetic code score at least, and the Jaro-Winkler they need for it. */
export const PHONETIC_SCORE = 0.92;
export const PHONETIC_JW_FLOOR = 0.78;

/** Below this, two tokens are different words rather than two spellings of one. */
export const TOKEN_FLOOR = 0.86;

function alignment(query: string[], candidate: string[]): number {
    const [short, long] = query.length <= candidate.length ? [query, candidate] : [candidate, query];
    const used = new Array<boolean>(long.length).fill(false);
    let sum = 0;
    let weight = 0;
    for (const t of short) {
        let best = 0;
        let bestAt = -1;
        for (let j = 0; j < long.length; j++) {
            if (used[j]) continue;
            const s = tokenSimilarity(t, long[j]);
            if (s > best) { best = s; bestAt = j; }
        }
        if (bestAt >= 0) used[bestAt] = true;
        // Weighted by length: a long word counts more than "al" or "de". A pair below
        // TOKEN_FLOOR is no spelling variant but another word, and counts as nothing.
        const w = Math.max(2, t.length);
        sum += (best >= TOKEN_FLOOR ? best : 0) * w;
        weight += w;
    }
    const avg = weight ? sum / weight : 0;
    const unpaired = long.length - short.length;
    // Each token of the longer name nobody paired with costs a little: a two-word query that
    // matches two words of a five-word listing is a candidate, not a certainty.
    return avg * (1 - Math.min(0.15, unpaired * 0.04));
}

/** One word against a name of several (or the other way round) scores at most this, unless the listing is an organisation. */
export const ONE_WORD_CAP = 0.8;
/** An organisation's one distinctive word ("Sberbank") is enough from this many letters on. */
export const ENTITY_WORD_MIN = 5;

export interface SimilarityOptions {
    /** The listing is an organisation (or a vessel, an aircraft): one distinctive word may identify it. */
    candidateIsEntity?: boolean;
}

/** How alike two names are, 0..1, also with their particles run together ("abd al rahman" / "abdulrahman"). */
export function nameSimilarity(query: string[], candidate: string[], opts: SimilarityOptions = {}): number {
    const raw = rawSimilarity(query, candidate, opts);
    const q = mergeParticles(query);
    const c = mergeParticles(candidate);
    if (!q && !c) return raw;
    return Math.max(raw, rawSimilarity(q ?? query, c ?? candidate, opts));
}

function rawSimilarity(query: string[], candidate: string[], opts: SimilarityOptions): number {
    if (!query.length || !candidate.length) return 0;
    // The words run together ("AlZawahiri" against "Al Zawahiri") only count when they are
    // nearly the same: across a whole name Jaro-Winkler is lenient, the alignment is not.
    const joined = jaroWinkler(query.join(''), candidate.join(''));
    const score = Math.max(joined >= 0.95 ? joined : 0, alignment(query, candidate));
    // One word against a longer name ("Hussein" against "Saddam Hussein"), or the other way
    // round, says little on its own about a person. An organisation is often known by one
    // distinctive word ("Sberbank" for "Sberbank of Russia"), so the cap is lifted for an
    // organisation's listing when that word is not short ("Bank" stays capped).
    // Only the query may be the one word: a one-word listing ("Devrez") against a longer query
    // ("Jan de Vries") stays capped.
    if ((query.length === 1) === (candidate.length === 1)) return score;
    const lift = opts.candidateIsEntity && query.length === 1 && query[0].length >= ENTITY_WORD_MIN;
    return lift ? score : Math.min(score, ONE_WORD_CAP);
}
