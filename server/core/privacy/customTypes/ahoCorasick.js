// @typecheck
'use strict';
/**
 * A literal multi-pattern matcher (Aho-Corasick) over UTF-16 code units.
 *
 * Why not a regex union of escaped words: a union of 500 alternatives is
 * backtracking work proportional to words × text on V8, and an admin's list
 * of customer names is exactly that shape. This walks the text ONCE, in time
 * linear in the text plus the number of matches, whatever the list holds.
 *
 * Case-insensitive matching is done by folding BOTH the words and the text
 * through `foldCode`, which maps one code unit to one code unit. Offsets in
 * the folded text are therefore offsets in the original text, and the span a
 * caller slices out is exactly what was there.
 */

/** @type {Uint16Array|null} */
let _foldTable = null;

/**
 * Length-preserving case fold of one UTF-16 code unit. Surrogates are left
 * alone (folding half a pair would corrupt it); a character whose case
 * mapping changes length (`ß`, `İ`) is left alone too. Upper-then-lower so
 * `ς`/`σ`/`Σ` and `ſ`/`s` fold together.
 * @param {number} code
 */
function foldCode(code) {
    if (!_foldTable) {
        const t = new Uint16Array(65536);
        for (let c = 0; c < 65536; c++) {
            if (c >= 0xD800 && c <= 0xDFFF) { t[c] = c; continue; }
            const ch = String.fromCharCode(c);
            const up = ch.toUpperCase();
            let folded = null;
            if (up.length === 1) {
                const low = up.toLowerCase();
                if (low.length === 1) folded = low;
            }
            if (folded === null) {
                const low = ch.toLowerCase();
                folded = low.length === 1 ? low : ch;
            }
            t[c] = folded.charCodeAt(0);
        }
        _foldTable = t;
    }
    return _foldTable[code];
}

/** Fold a whole string (same length as the input, by construction). */
function foldString(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(foldCode(s.charCodeAt(i)));
    return out;
}

class AhoCorasick {
    constructor() {
        /** @type {Array<Map<number, number>>} */
        this.next = [new Map()];
        /** @type {number[]} */
        this.fail = [0];
        /** @type {Array<Array<any>|null>} */
        this.out = [null];
        /** Nearest proper suffix state that carries output (0 = none). @type {number[]} */
        this.outLink = [0];
        this.size = 0;
        this.built = false;
    }

    /**
     * @param {string} word  already folded when the automaton is case-insensitive
     * @param {object} payload  reported with every match; must carry `len`
     */
    add(word, payload) {
        if (!word) return;
        let s = 0;
        for (let i = 0; i < word.length; i++) {
            const c = word.charCodeAt(i);
            let n = this.next[s].get(c);
            if (n === undefined) {
                n = this.next.length;
                this.next.push(new Map());
                this.fail.push(0);
                this.out.push(null);
                this.outLink.push(0);
                this.next[s].set(c, n);
            }
            s = n;
        }
        (this.out[s] || (this.out[s] = [])).push(payload);
        this.size += 1;
        this.built = false;
    }

    build() {
        const queue = [];
        for (const v of this.next[0].values()) { this.fail[v] = 0; this.outLink[v] = 0; queue.push(v); }
        for (let qi = 0; qi < queue.length; qi++) {
            const u = queue[qi];
            for (const [c, v] of this.next[u]) {
                let f = this.fail[u];
                while (f && !this.next[f].has(c)) f = this.fail[f];
                const t = this.next[f].get(c);
                this.fail[v] = t !== undefined && t !== v ? t : 0;
                const fv = this.fail[v];
                this.outLink[v] = this.out[fv] ? fv : this.outLink[fv];
                queue.push(v);
            }
        }
        this.built = true;
        return this;
    }

    /**
     * Report every occurrence (overlapping ones included).
     * @param {string} text
     * @param {boolean} fold  fold the text on the fly (case-insensitive automaton)
     * @param {(start: number, end: number, payload: any) => void} onMatch
     */
    search(text, fold, onMatch) {
        if (!this.built) this.build();
        const { next, fail, out, outLink } = this;
        let s = 0;
        for (let i = 0; i < text.length; i++) {
            const raw = text.charCodeAt(i);
            const c = fold ? foldCode(raw) : raw;
            while (s && !next[s].has(c)) s = fail[s];
            const n = next[s].get(c);
            s = n === undefined ? 0 : n;
            if (!s) continue;
            let o = out[s] ? s : outLink[s];
            while (o) {
                for (const p of /** @type {any[]} */ (out[o])) onMatch(i + 1 - p.len, i + 1, p);
                o = outLink[o];
            }
        }
    }
}

module.exports = { AhoCorasick, foldCode, foldString };
