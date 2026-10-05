// @typecheck
/**
 * Tokenisation — minting reversible `[category_n]` tokens for detected spans,
 * with alias coalescing and the counter continuity that keeps one value on one
 * token across the turns of a conversation.
 */

const { resolveSpanOverlaps } = require('../../dlp/spanOverlap');
const { isCustomTypeId } = require('../customTypes/ids');
const { tokenKeyFor } = require('../customTypes/registry');
const { sweepNameOccurrences } = require('./nameSweep');
const { splitAtCellBreaks } = require('./cellSplit');

/**
 * Tokenize PII in text — replace each detected entity with a reversible token.
 *
 * Tokens look like: [PII:iban:1], [PII:email:1], [PII:name:1]
 *
 * Returns { tokenizedText, tokenMap, sweptEntities } where tokenMap maps each
 * token → real value. Call restoreTokens(text, tokenMap) to reverse.
 * `sweptEntities` are the spans this call added on top of `entities`: further
 * occurrences of a person already found in this text or conversation
 * (`sweepNameOccurrences`, BFSF-269). Callers that count mentions add them.
 *
 * When `existingTokenMap` is passed (the conversation's accumulated token map,
 * optionally unioned with matching entries from the user's tokenization vault),
 * the per-category counter is seeded from it and known values reuse their
 * existing token. Without this, turn 2 of a redacted conversation would
 * restart counters at 1 and silently overwrite turn 1's mappings — same value
 * gets a duplicate token, two different values collide on the same token.
 *
 * `options.counterFloors` carries the vault's per-category high-water marks.
 * The seed map only contains vault entries that matched THIS text, so the
 * floors are what stop a fresh mint from colliding with a token the vault has
 * already issued to some other value in another conversation.
 *
 * `options.reserved` lists `{ offset, length }` ranges the caller replaces
 * itself afterwards (tool-result values of a blocked category). The name sweep
 * leaves them whole, so that later literal replacement still finds them.
 *
 * Two guarantees the splice loop relies on, both established up front:
 *   - spans are DISJOINT (`resolveSpanOverlaps`), because splicing overlapping
 *     spans corrupts the placeholders already written;
 *   - every stored value is a real slice of `text`, and spelling variants and
 *     name parts share one token (`_buildAliasIndex`).
 */
// ── Alias coalescing ─────────────────────────────────────────────────────
// Without it the token map fragments: one real transcript produced 20
// [organization_N] tokens for ~8 companies and gave "Tom" and "Tom Smit"
// separate person tokens. The model cannot tell that [person_4] and
// [person_3] are the same human, and the user sees a table that looks broken.

// Words that carry no identity on their own — Dutch/English name glue and
// company-form suffixes. A span built only from these can never be the
// distinctive part of a longer name, so "van der" must not fold into
// "Theodorus van der Brug".
const _ALIAS_PARTICLES = new Set([
    'van', 'de', 'der', 'den', 'het', 'ten', 'ter', 'te', 'op', 'aan', 'in',
    // The 't / 's of "van 't Hof" and "'s-Gravenhage", as in the guard's list.
    't', 's',
    'the', 'of', 'and', 'en', 'bv', 'nv', 'ltd', 'inc', 'llc', 'gmbh', 'plc', 'ag', 'sa',
]);

/** Comparison key that ignores case, punctuation and whitespace. */
function _aliasNormKey(catKey, value) {
    const n = String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return n ? `${catKey}|${n}` : null;
}

/** Word list used for subsumption ("Tom" ⊂ "Tom Smit"). */
function _aliasWords(value) {
    return String(value || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function _aliasIsSubsetOf(words, otherWords) {
    return words.every(w => otherWords.includes(w));
}

/**
 * Map every observed value onto the canonical form its token should carry.
 *
 * Two rules, both conservative:
 *   1. SPELLING VARIANTS — values that are identical once case, punctuation and
 *      whitespace are stripped share a token ("Beheer IT" = "Beheer-IT").
 *      The longest spelling becomes the canonical one.
 *   2. NAME PARTS (Person/Organization only) — a value whose words are a proper
 *      subset of a longer value's words folds into it ("Tom" → "Tom Smit").
 *      AMBIGUITY GUARD: if the short form fits more than one longer value it
 *      stays on its own token — two different Toms in one conversation must not
 *      silently become one person. Hosts that nest inside each other ("Tom
 *      Smit" ⊂ "Tom Smit jr") are one identity written twice, so the maximal
 *      host wins rather than the merge being abandoned.
 *
 * Deliberately NOT fuzzy: "24x7 ICT" vs "24-7 ICT" and "Beeflow"/"Bflow" need
 * edit-distance matching, which is a different (and riskier) problem.
 *
 * @param {Array<[string, string]>} pairs  [categoryKey, value] observations.
 * @returns {Map<string, string>} `${catKey}|${trimmedValue}` → canonical value.
 */
function _buildAliasIndex(pairs) {
    const byCat = new Map();
    for (const [catKey, value] of pairs) {
        const v = String(value || '').trim();
        if (!v) continue;
        if (!byCat.has(catKey)) byCat.set(catKey, new Map());
        const values = byCat.get(catKey);
        if (!values.has(v)) values.set(v, _aliasWords(v));
    }

    const canonical = new Map();
    for (const [catKey, values] of byCat) {
        // Rule 1 — one representative per normalised spelling. Strictly-greater
        // so the first value seen wins ties, and the existing conversation map
        // is fed in first: token numbering stays stable across turns.
        const repByNorm = new Map();
        for (const v of values.keys()) {
            const nk = _aliasNormKey(catKey, v);
            if (!nk) continue;
            const cur = repByNorm.get(nk);
            if (!cur || v.length > cur.length) repByNorm.set(nk, v);
        }
        const repOf = v => repByNorm.get(_aliasNormKey(catKey, v)) || v;

        const subsumable = catKey === 'person' || catKey === 'organization';
        const entries = [...values.entries()];
        for (const [v, words] of entries) {
            let rep = repOf(v);
            const distinctive = words.some(w => w.length >= 3 && !_ALIAS_PARTICLES.has(w));
            if (subsumable && distinctive) {
                const hosts = new Set();
                for (const [other, otherWords] of entries) {
                    if (other === v || otherWords.length <= words.length) continue;
                    if (_aliasIsSubsetOf(words, otherWords)) hosts.add(repOf(other));
                }
                if (hosts.size > 0) {
                    const list = [...hosts];
                    let maximal = list[0];
                    for (const h of list.slice(1)) {
                        if (_aliasIsSubsetOf(_aliasWords(maximal), _aliasWords(h))) maximal = h;
                    }
                    const maximalWords = _aliasWords(maximal);
                    if (list.every(h => _aliasIsSubsetOf(_aliasWords(h), maximalWords))) rep = maximal;
                }
            }
            canonical.set(`${catKey}|${v}`, rep);
        }
    }
    return canonical;
}

/**
 * Category → token prefix. `USSocialSecurityNumber` → `ussocialsecuritynumber`.
 *
 * A "Your own data" type is named by the id in `category` (`cdt_…`) and its
 * prefix is the placeholder key the admin chose (`[project_code_1]`), looked
 * up by id. Derived from the id on purpose: several normalisers rebuild
 * entities with a fixed set of fields, and the id is the one field every one
 * of them keeps.
 */
function _tokenCategoryKey(entity) {
    if (isCustomTypeId(entity.category)) return tokenKeyFor(entity.category);
    return String(entity.category || 'data').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

const _TOKEN_NAME_RE = /^\[([a-z0-9_]+)_(\d+)\]$/;

/**
 * @returns {{ tokenizedText: string, tokenMap: Record<string, string>, sweptEntities: import('./nameSweep').SweptSpan[] }}
 */
function tokenizeText(text, entities, existingTokenMap = null, options = {}) {
    if (!entities || entities.length === 0) return { tokenizedText: text, tokenMap: {}, sweptEntities: [] };

    // Seed counters + value→token reverse index from the conversation's
    // accumulated map so subsequent turns extend instead of restart.
    const counters = {};

    // Per-category floors from the user's tokenization vault. The seed map only
    // carries the vault entries that MATCHED this text, so without floors a new
    // value could mint `[person_2]` while the vault already holds a different
    // `[person_2]` — two people on one token, in different conversations.
    // Floors are high-water marks and never decrease, including after eviction.
    const floors = options.counterFloors;
    if (floors && typeof floors === 'object') {
        for (const [cat, n] of Object.entries(floors)) {
            const v = parseInt(n, 10);
            if (Number.isFinite(v) && v > 0) counters[cat] = Math.max(counters[cat] || 0, v);
        }
    }
    const existingByValue = new Map();
    // Accept BOTH a plain object and a Map. dlpRunner's public accessor returns
    // an object, but its internal store (`conversationTokenMaps`) is a Map of
    // Maps — so handing this function the inner Map is an easy and completely
    // silent mistake: `typeof aMap === 'object'` is true, `Object.entries(aMap)`
    // is `[]`, the seeding loop runs zero times, and numbering restarts at 1.
    // That failure mode is invisible and lands exactly on the collision this
    // parameter exists to prevent, so normalise rather than trust the caller.
    const existingEntries = existingTokenMap instanceof Map
        ? [...existingTokenMap.entries()]
        : (existingTokenMap && typeof existingTokenMap === 'object'
            ? Object.entries(existingTokenMap)
            : []);
    // Splicing by offset is only safe for DISJOINT spans: with an overlap the
    // tail slice starts inside the placeholder the previous iteration wrote and
    // eats part of it (a production failure of the shape `[person_8] → "…van
    // der Brugrganization_1"`, names fictional). Only dlpRunner deduped before
    // calling in; the other four callers did not. Resolve here, at the single
    // mint site, so every caller is covered and the guarantee cannot be
    // forgotten again.
    // …and no span may cross a line or table cell (BFSF-299): one token over
    // three cells shifted every later column of the row. Cut after the overlap
    // pass, so the pieces of disjoint spans stay disjoint, and before the name
    // sweep and the alias index, so both see one cell per value.
    const resolved = splitAtCellBreaks(resolveSpanOverlaps(entities, text), text, { particles: _ALIAS_PARTICLES });

    // A person found once is replaced everywhere (BFSF-269/300): the detector
    // misses some mentions of a name it found elsewhere, and alias coalescing
    // keeps only the long form in the token map, so nothing downstream would
    // catch the missed ones. The swept spans are disjoint from `resolved` and
    // go through the same alias index below, one token per person.
    const sweptEntities = sweepNameOccurrences({
        text, spans: resolved, seedEntries: existingEntries,
        categoryKeyOf: _tokenCategoryKey, particles: _ALIAS_PARTICLES,
        reserved: Array.isArray(options.reserved) ? options.reserved : [],
    });

    // The value each span really occupies. Taken from `text` rather than from
    // `entity.text` so the token map can never hold a string that is not
    // actually in the document.
    const prepared = [];
    const trimmedText = text.trim();
    for (const entity of sweptEntities.length ? resolved.concat(sweptEntities) : resolved) {
        const inRange = Number.isFinite(entity.offset) && entity.offset >= 0
            && Number.isFinite(entity.length) && entity.length > 0
            && entity.offset + entity.length <= text.length;
        const raw = inRange
            ? text.slice(entity.offset, entity.offset + entity.length)
            : String(entity.text || '');
        if (!raw.trim()) continue;
        // BFSF-358B — "do not expand a user's own literal input".
        //
        // When the detected span IS the whole scanned text, that text is a
        // single literal value somebody typed, not prose that happens to
        // mention a name. Alias coalescing may then not rewrite it: rule 2
        // would fold a short person name into the LONGEST variant seen earlier
        // in the run, and rule 1 would swap its spelling/casing. In an automation
        // every string leaf of a step's inputs is tokenized and restored from
        // the run vault, so a Gmail search for "Ruben" left the platform as
        // "van Ruben van de Laar" and returned nothing, while a search for what
        // was actually typed did find the mails (names fictional).
        //
        // Marking the span here (rather than weakening _buildAliasIndex) keeps
        // coalescing fully intact everywhere else: inside a sentence, a
        // transcript or a document body the span is never the whole text.
        const wholeInput = raw.trim() === trimmedText;
        prepared.push({ entity, inRange, raw, wholeInput, catKey: _tokenCategoryKey(entity) });
    }
    if (prepared.length === 0) return { tokenizedText: text, tokenMap: {}, sweptEntities: [] };

    // Existing values first so their spelling wins ties and token numbering
    // stays stable across turns.
    /** @type {Array<[string, string]>} */
    const aliasPairs = [];
    for (const [tok, real] of existingEntries) {
        const m = _TOKEN_NAME_RE.exec(tok);
        if (m) aliasPairs.push([m[1], real]);
    }
    for (const p of prepared) aliasPairs.push([p.catKey, p.raw]);
    const aliasIndex = _buildAliasIndex(aliasPairs);
    const canonicalValue = (catKey, value) => {
        const v = String(value || '').trim();
        return aliasIndex.get(`${catKey}|${v}`) || v;
    };

    for (const [tok, real] of existingEntries) {
        const m = _TOKEN_NAME_RE.exec(tok);
        if (!m) continue;
        const cat = m[1];
        const idx = parseInt(m[2], 10);
        if (Number.isFinite(idx)) counters[cat] = Math.max(counters[cat] || 0, idx);
        // Keyed on the CANONICAL value: turn 1's "Tom" and turn 2's "Tom Smit"
        // must land on the same token, or the alias merge would break exactly
        // the cross-turn continuity this index exists to provide.
        const dedupKey = `${cat}|${canonicalValue(cat, real)}`;
        if (!existingByValue.has(dedupKey)) existingByValue.set(dedupKey, tok);
    }

    // Sort by offset descending so we can splice from end without shifting offsets
    const sorted = [...prepared].sort((a, b) => b.entity.offset - a.entity.offset);
    /** @type {Record<string, string>} */
    const tokenMap = {};
    // Dedup within a category (this call): values that resolve to the same
    // canonical form share one token. Without this, the same name appearing 5
    // times in an email becomes [person_2..6] — five rows in the token-map UI,
    // all pointing at "Jack". Matching runs on the canonical value from
    // _buildAliasIndex, so "Jack"/"jack"/"Jack " and "Tom"/"Tom Smit" collapse
    // and restoration writes the canonical spelling at every site.
    const seenByCategory = new Map();

    let tokenized = text;
    for (const { entity, inRange, raw, wholeInput, catKey } of sorted) {
        // Human-friendly token format — `[email_1]`, `[phone_2]`, … — easier
        // for the LLM to echo back verbatim than the old `[PII:email:1]`.
        // The restore path is format-agnostic (see server/core/dlp/untokeniseStream.js),
        // so this change is backwards-compatible with any tokens still in flight.
        // `wholeInput` (BFSF-358B): the span IS the entire scanned text, so it is
        // a literal a user typed — stored VERBATIM, never canonicalised, so
        // tokenize → restore is byte-identical and a search query still means
        // what it said.
        const value = wholeInput ? raw : canonicalValue(catKey, raw);
        const dedupKey = `${catKey}|${value}`;
        // Reuse priority: within-call dedup → conversation-wide reuse → mint fresh.
        let token = seenByCategory.get(dedupKey) || existingByValue.get(dedupKey);
        if (!token) {
            counters[catKey] = (counters[catKey] || 0) + 1;
            token = `[${catKey}_${counters[catKey]}]`;
        }
        seenByCategory.set(dedupKey, token);
        // Record every token used in this call (new or reused) so the caller's
        // per-message tokenMap and the conv-map merge both stay complete — a
        // reused token still needs to appear in the per-message map for the
        // user-side restore path (_restoreTokensInMessages).
        tokenMap[token] = value;
        // Replace the exact span (using offset if available, else string replace)
        if (inRange) {
            tokenized = tokenized.slice(0, entity.offset) + token + tokenized.slice(entity.offset + entity.length);
        } else {
            tokenized = tokenized.replace(raw, token);
        }
    }

    return { tokenizedText: tokenized, tokenMap, sweptEntities };
}

module.exports = { tokenizeText, _tokenCategoryKey };
