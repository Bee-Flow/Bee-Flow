// @typecheck
/**
 * No PII span may cross a line or a table cell (BFSF-299), Node side.
 *
 * The guard service already cuts its own spans at cell breaks
 * (guard-service/app/services/pii/postprocess.py, `_cell_pieces` /
 * `_is_fragment`), but the tokenizer also takes spans from other detectors:
 * regexes, custom data types, cached scans. tokenizeText splices each span into
 * ONE token, so a span over "<street> <nr>\n<postcode>\n<city>" folded three
 * cells into one, every later column of that row shifted left, and the model
 * put values in the wrong column. This is the same rule, in the same terms:
 * cut at every break, trim each piece, drop pieces that are no value of their
 * own.
 */

// Every line boundary, the tab of a pasted spreadsheet and the `|` border of a
// Markdown table. Same set as the guard's _CELL_BREAKS.
const CELL_BREAK_RE = /[\n\r\t\v\f\x1c\x1d\x1e\x85\u2028\u2029|]/;
const CELL_BREAK_RE_G = /[\n\r\t\v\f\x1c\x1d\x1e\x85\u2028\u2029|]/g;
const LETTER_WORD_RE = /\p{L}+/gu;

/**
 * True when `piece`, cut from a span at a cell break, is no value of its own:
 * for a name, a piece with no identifying word (a lone "ter" cell); for
 * anything else, no letter and fewer than four digits (a house-number cell or
 * the next row's number). Tokens are restored by substring, so a "ter" or "7"
 * token would rewrite every later "winter" or "2027".
 *
 * @param {string} category
 * @param {string} piece
 * @param {Set<string>} particles
 */
function isFragment(category, piece, particles) {
    if (category === 'Person' || category === 'Organization') {
        return !(piece.match(LETTER_WORD_RE) || []).some(w => !particles.has(w.toLowerCase()));
    }
    if (/\p{L}/u.test(piece)) return false;
    return (piece.match(/\d/g) || []).length < 4;
}

/**
 * Cut every span that crosses a cell break into one span per cell. Spans that
 * do not cross one come back as they were (same object).
 *
 * @template {{ offset: number, length: number, category?: string, text?: string }} E
 * @param {E[]} entities
 * @param {string} text
 * @param {{ particles: Set<string> }} opts
 * @returns {E[]}
 */
function splitAtCellBreaks(entities, text, { particles }) {
    const out = [];
    for (const e of entities || []) {
        const start = e?.offset;
        const end = Number.isFinite(start) && Number.isFinite(e?.length) ? start + e.length : NaN;
        if (!Number.isFinite(end) || start < 0 || end > text.length || !CELL_BREAK_RE.test(text.slice(start, end))) {
            out.push(e);
            continue;
        }
        let pos = start;
        const cuts = [];
        CELL_BREAK_RE_G.lastIndex = 0;
        for (const m of text.slice(start, end).matchAll(CELL_BREAK_RE_G)) {
            cuts.push([pos, start + m.index]);
            pos = start + m.index + m[0].length;
        }
        cuts.push([pos, end]);
        for (let [s, t] of cuts) {
            while (s < t && /\s/.test(text[s])) s += 1;
            while (t > s && /\s/.test(text[t - 1])) t -= 1;
            if (t <= s) continue;
            const piece = text.slice(s, t);
            if (isFragment(String(e.category || ''), piece, particles)) continue;
            out.push({ ...e, offset: s, length: t - s, text: piece });
        }
    }
    return out;
}

module.exports = { splitAtCellBreaks, isFragment };
