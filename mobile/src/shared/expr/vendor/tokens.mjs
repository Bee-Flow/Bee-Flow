// @typecheck strict
/**
 * The tokenizer of the expression language (engine.mjs parses its tokens).
 * Split out of engine.mjs unchanged: the grammar and the safety model are
 * described there.
 */

import { ExprError } from './limits.mjs';

// ── Tokenizer ──────────────────────────────────────────
export const TOKEN = {
    NUMBER: 'NUM', STRING: 'STR', IDENT: 'ID', BOOL: 'BOOL', NULL: 'NULL',
    LPAREN: '(', RPAREN: ')', LBRACK: '[', RBRACK: ']',
    DOT: '.', COMMA: ',', QMARK: '?', COLON: ':',
    OR: '||', AND: '&&', EQ: '==', NEQ: '!=', SEQ: '===', SNEQ: '!==',
    LT: '<', LTE: '<=', GT: '>', GTE: '>=',
    PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/', PERCENT: '%', CARET: '^',
    BANG: '!', ASSIGN: '=', EOF: 'EOF',
};

/**
 * @param {unknown} src
 * @returns {Array<{ t: string, v?: string | number | boolean, raw?: string, i: number }>}
 */
export function tokenize(src) {
    if (typeof src !== 'string') throw new ExprError('Expression must be a string', 0);
    const tokens = [];
    let i = 0;
    let brackets = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        const prev = tokens[tokens.length - 1];
        const memberDot = c === '.' && prev && (prev.t === TOKEN.IDENT || prev.t === TOKEN.RBRACK || prev.t === TOKEN.RPAREN);
        if (memberDot) { tokens.push({ t: TOKEN.DOT, i }); i++; continue; }
        // Right after a member dot, a name is a KEY whatever it looks like:
        // `items.0.subject` (digits), `flags.true`, `naam.prénom`. The same
        // spellings a ref binding resolves (path.mjs), so a picked path never
        // works in a field and breaks in a formula.
        const afterDot = tokens.length > 0 && tokens[tokens.length - 1].t === TOKEN.DOT;
        if (afterDot && /[\p{L}\p{N}_$]/u.test(c)) {
            let j = i;
            while (j < src.length && /[\p{L}\p{N}\p{M}_$]/u.test(src[j])) j++;
            tokens.push({ t: TOKEN.IDENT, v: src.slice(i, j), i });
            i = j; continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
            let j = i;
            while (j < src.length && /[0-9.]/.test(src[j])) j++;
            tokens.push({ t: TOKEN.NUMBER, v: parseFloat(src.slice(i, j)), raw: src.slice(i, j), i });
            i = j; continue;
        }
        if (c === '"' || c === "'") {
            const q = c; let j = i + 1; let out = '';
            while (j < src.length && src[j] !== q) {
                if (src[j] === '\\' && j + 1 < src.length) {
                    const n = src[j + 1];
                    // JSON's escapes, so a key the builder quoted with
                    // JSON.stringify (path.mjs formatKey) reads back here too.
                    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
                        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
                        j += 6;
                        continue;
                    }
                    out += (n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'b' ? '\b' : n === 'f' ? '\f' : n);
                    j += 2;
                } else { out += src[j]; j++; }
            }
            if (j >= src.length) throw new ExprError('Unterminated string in expression', i);
            tokens.push({ t: TOKEN.STRING, v: out, i });
            i = j + 1; continue;
        }
        if (/[\p{L}_$]/u.test(c)) {
            let j = i;
            while (j < src.length && /[\p{L}\p{N}\p{M}_$]/u.test(src[j])) j++;
            const word = src.slice(i, j);
            if (word === 'true' || word === 'false') tokens.push({ t: TOKEN.BOOL, v: word === 'true', i });
            else if (word === 'null') tokens.push({ t: TOKEN.NULL, i });
            else tokens.push({ t: TOKEN.IDENT, v: word, i });
            i = j; continue;
        }
        const two = src.slice(i, i + 2);
        const three = src.slice(i, i + 3);
        if (three === '===') { tokens.push({ t: TOKEN.SEQ, i }); i += 3; continue; }
        if (three === '!==') { tokens.push({ t: TOKEN.SNEQ, i }); i += 3; continue; }
        if (two === '||') { tokens.push({ t: TOKEN.OR, i }); i += 2; continue; }
        if (two === '&&') { tokens.push({ t: TOKEN.AND, i }); i += 2; continue; }
        if (two === '==') { tokens.push({ t: TOKEN.EQ, i }); i += 2; continue; }
        if (two === '!=') { tokens.push({ t: TOKEN.NEQ, i }); i += 2; continue; }
        if (two === '<=') { tokens.push({ t: TOKEN.LTE, i }); i += 2; continue; }
        if (two === '>=') { tokens.push({ t: TOKEN.GTE, i }); i += 2; continue; }
        /** @type {Record<string, string>} */
        const single = {
            '(': TOKEN.LPAREN, ')': TOKEN.RPAREN, '[': TOKEN.LBRACK, ']': TOKEN.RBRACK,
            '.': TOKEN.DOT, ',': TOKEN.COMMA, '?': TOKEN.QMARK, ':': TOKEN.COLON,
            '<': TOKEN.LT, '>': TOKEN.GT, '+': TOKEN.PLUS, '-': TOKEN.MINUS,
            '*': TOKEN.STAR, '/': TOKEN.SLASH, '%': TOKEN.PERCENT, '!': TOKEN.BANG,
            // `^` is EXPONENT here, not bitwise XOR. The grammar has no bitwise
            // operators at all, so there is nothing to collide with, and every
            // non-programmer who types 2^10 means 1024. Before this it was an
            // "Unexpected character", so no stored expression can contain one.
            '^': TOKEN.CARET,
        };
        // A single `=` only exists inside a path's brackets, as the match
        // segment `headers[name="Subject"]` (path.mjs). Anywhere else it is
        // still the old error, so `a = b` keeps telling the author to write ==.
        if (c === '=' && brackets > 0) { tokens.push({ t: TOKEN.ASSIGN, i }); i++; continue; }
        if (c === '[') brackets++;
        else if (c === ']' && brackets > 0) brackets--;
        if (single[c]) { tokens.push({ t: single[c], i }); i++; continue; }
        throw new ExprError(`Unexpected character in expression: ${c}`, i);
    }
    tokens.push({ t: TOKEN.EOF, i: src.length });
    return tokens;
}
