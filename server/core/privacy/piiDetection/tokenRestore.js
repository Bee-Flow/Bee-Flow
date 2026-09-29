// @typecheck
/**
 * Token restoration — putting real values back where the tokens are, both in
 * plain text and in rich text where markup may have split or escaped a token.
 */

// Normalise a token (or a token-like span) to a comparison key: lowercase,
// letters+digits only. Collapses every drift variant the LLM produces —
// `[person_2]`, `[person2]`, `[Person 2]`, `[email]2` — onto one key
// (`person2` / `email2`) so a single map lookup matches them all.
function _normToken(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Restore PII tokens in text back to real values.
 * Call on AI response before displaying to user.
 *
 * ONE pass over the original text. At each site the regex tries an EXACT token
 * first, then a drift-tolerant bracketed span:
 *   - Exact — the original verbatim-token restore (incl. legacy `[PII:cat:n]`
 *     shapes and a real token immediately followed by an unrelated digit,
 *     `[person_2]5` → `Jane5`). Substitution still requires an exact (case-
 *     sensitive) map key, so case-folding here never mis-restores.
 *   - Drift — when the model NATURALISES a token while writing (drops the
 *     underscore `[person_2]`→`[person2]`, or pushes the counter outside the
 *     brackets `[email_2]`→`[email]2`), the exact branch misses it. The fallback
 *     normalises bracketed token-like spans (interior restricted to `[a-z0-9_ ]`
 *     so markdown links / arbitrary `[text]` are left alone) plus an optional
 *     trailing counter, and substitutes ONLY when the normalised form matches a
 *     real token key. Without this the raw `[person2]`/`[email]2` leaked into the
 *     Legal/Notebook document, AI-added sources and chat.
 *
 * Single pass is what keeps it safe: a token literal that appears INSIDE a value
 * just restored at an earlier site is never re-scanned, so it can't cascade
 * (e.g. `[a_1]` → "see [b_1] here" must NOT then restore `[b_1]`). Longest-first
 * ordering of the exact alternation keeps `[x_1]` vs `[x_10]` unambiguous.
 */
function restoreTokens(text, tokenMap) {
    if (!tokenMap || !text) return text;
    const keys = Object.keys(tokenMap);
    if (keys.length === 0) return text;

    // Exact alternation (longest-first), unchanged from the original restore.
    const exactSrc = keys
        .sort((a, b) => b.length - a.length)
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

    // Normalised index for the drift-tolerant fallback: norm(key) → real value.
    const byNorm = new Map();
    for (const k of keys) {
        const nk = _normToken(k);
        if (nk && !byNorm.has(nk)) byNorm.set(nk, tokenMap[k]);
    }

    // Exact branch first (ordered alternation), drift branch second. `g` flag
    // restores every occurrence; `i` only widens the drift branch — the exact
    // branch still resolves through a case-sensitive map lookup below.
    const re = new RegExp(`(?:${exactSrc})|(\\[[a-z0-9_ ]{1,60}\\])([ \\t]?\\d{1,4})?`, 'gi');
    return text.replace(re, (m, bracket, tail) => {
        if (Object.prototype.hasOwnProperty.call(tokenMap, m)) return tokenMap[m];
        if (bracket) {
            if (tail) {
                // `[email]2` — counter outside the brackets. Try the whole span
                // first; fall back to the bracket alone so a real token trailed
                // by an unrelated digit keeps that digit (`[person2]5` → `Jane5`).
                const withTail = byNorm.get(_normToken(bracket + tail));
                if (withTail !== undefined) return withTail;
                const bracketOnly = byNorm.get(_normToken(bracket));
                if (bracketOnly !== undefined) return bracketOnly + tail;
            } else {
                const v = byNorm.get(_normToken(bracket));
                if (v !== undefined) return v;
            }
        }
        return m;
    });
}

/**
 * Restore tokens in RICH TEXT (HTML / Markdown) — tolerant of formatting that
 * splits a token across inline markup or escapes its delimiters. The plain
 * restoreTokens() handles emphasis AROUND a token (`<em>[person_1]</em>`), but
 * when the editor/markdown layer puts markup INSIDE the token, or escapes its
 * brackets/underscore, the token no longer matches:
 *   `[person<em>1</em>]`  ·  `<em>[person</em>1]`  ·  `\[person\_1\]`  ·  `[person\_1]`
 * The drafted document went through exactly this (a token typed in italic/bold),
 * so `[person_1]` leaked into the editor unrestored even though it was mapped.
 *
 * Strategy: run the normal restore first (fast path for clean/drifted tokens),
 * then a fallback that matches a bracket span which MAY contain inline HTML tags
 * or backslash escapes (plus an optional outside-the-brackets counter), strips
 * that noise to a compare key, and substitutes only when the cleaned key matches
 * a known token. Use this for the notebook DOCUMENT; plain restoreTokens() stays
 * the default for chat/messages where there's no markup.
 */
function restoreTokensInRichText(text, tokenMap) {
    if (!tokenMap || !text) return text;
    const keys = Object.keys(tokenMap);
    if (keys.length === 0) return text;
    let out = restoreTokens(text, tokenMap);
    const byNorm = new Map();
    for (const k of keys) { const nk = _normToken(k); if (nk && !byNorm.has(nk)) byNorm.set(nk, tokenMap[k]); }
    if (byNorm.size === 0) return out;
    // `[` then inner = inline tags (<...>), backslash-escapes (\x) or ordinary
    // chars (not ] < \\ newline), then an optionally-escaped `]`, then an
    // optional trailing counter. Bounded length keeps it from running away.
    const re = /\\?\[(?:<[^>]*>|\\.|[^\]<\n\\]){1,80}\\?\](?:[ \t]{0,2}\d{1,4})?/gi;
    out = out.replace(re, (m) => {
        // Clean to a compare key: drop HTML tags, then drop every non-alphanumeric
        // (brackets, underscores, backslashes, spaces) and lowercase. So
        // `[person<em>1</em>]` and `\[person\_1\]` both reduce to `person1`.
        const clean = m.replace(/<[^>]*>/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        const v = byNorm.get(clean);
        return v !== undefined ? v : m;
    });
    return out;
}

module.exports = { restoreTokens, restoreTokensInRichText };
