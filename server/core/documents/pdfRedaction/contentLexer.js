'use strict';

/**
 * PDF content-stream lexer that keeps byte offsets.
 *
 * Redaction never re-serialises a page: it cuts the byte ranges of the operators that draw a
 * customer mark and leaves every other byte as it was. That only works when each operation
 * knows exactly where it starts and ends, which is what this lexer records.
 *
 * Operand values: numbers are JS numbers, names are `{ name }`, strings are `{ bytes }`
 * (a Buffer), arrays are JS arrays, dictionaries are `{ dict: { key: value } }`,
 * true/false/null are the JS values. An inline image (BI … ID … EI) is one operation `BI`.
 */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isWhite = (c) => WHITESPACE.has(c);
const isRegular = (c) => c !== undefined && !WHITESPACE.has(c) && !DELIMITERS.has(c);

class ContentLexer {
    constructor(buf) {
        this.buf = buf;
        this.pos = 0;
    }

    skipWhitespaceAndComments() {
        const b = this.buf;
        while (this.pos < b.length) {
            const c = b[this.pos];
            if (isWhite(c)) { this.pos++; continue; }
            if (c === 0x25) { // %
                while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
                continue;
            }
            break;
        }
    }

    /** Next token as `{ type, value, start, end }`, or null at the end of the stream. */
    next() {
        this.skipWhitespaceAndComments();
        const b = this.buf;
        if (this.pos >= b.length) return null;
        const start = this.pos;
        const c = b[this.pos];

        if (c === 0x2f) return this.readName(start);
        if (c === 0x28) return { type: 'value', value: { bytes: this.readLiteralString() }, start, end: this.pos };
        if (c === 0x3c) {
            if (b[this.pos + 1] === 0x3c) { this.pos += 2; return { type: 'dictOpen', start, end: this.pos }; }
            return { type: 'value', value: { bytes: this.readHexString() }, start, end: this.pos };
        }
        if (c === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; return { type: 'dictClose', start, end: this.pos }; }
        if (c === 0x5b) { this.pos++; return { type: 'arrayOpen', start, end: this.pos }; }
        if (c === 0x5d) { this.pos++; return { type: 'arrayClose', start, end: this.pos }; }
        if (c === 0x7b || c === 0x7d || c === 0x29 || c === 0x3e) {
            // Stray delimiter: skip it rather than loop forever. A stream this broken is caught by
            // the caller, which refuses to edit a page whose operands do not add up.
            this.pos++;
            return { type: 'junk', start, end: this.pos };
        }

        while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
        const word = b.toString('latin1', start, this.pos);
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { type: 'value', value: Number(word), start, end: this.pos };
        if (word === 'true') return { type: 'value', value: true, start, end: this.pos };
        if (word === 'false') return { type: 'value', value: false, start, end: this.pos };
        if (word === 'null') return { type: 'value', value: null, start, end: this.pos };
        return { type: 'op', value: word, start, end: this.pos };
    }

    readName(start) {
        const b = this.buf;
        this.pos++; // '/'
        let out = '';
        while (this.pos < b.length && isRegular(b[this.pos])) {
            if (b[this.pos] === 0x23 && /^[0-9a-fA-F]{2}$/.test(b.toString('latin1', this.pos + 1, this.pos + 3))) {
                out += String.fromCharCode(parseInt(b.toString('latin1', this.pos + 1, this.pos + 3), 16));
                this.pos += 3;
            } else {
                out += String.fromCharCode(b[this.pos]);
                this.pos++;
            }
        }
        return { type: 'value', value: { name: out }, start, end: this.pos };
    }

    readLiteralString() {
        const b = this.buf;
        this.pos++; // '('
        const out = [];
        let depth = 1;
        while (this.pos < b.length) {
            const c = b[this.pos++];
            if (c === 0x5c) { // backslash
                const n = b[this.pos++];
                if (n === undefined) break;
                if (n === 0x6e) out.push(0x0a);
                else if (n === 0x72) out.push(0x0d);
                else if (n === 0x74) out.push(0x09);
                else if (n === 0x62) out.push(0x08);
                else if (n === 0x66) out.push(0x0c);
                else if (n === 0x0d) { if (b[this.pos] === 0x0a) this.pos++; } // line continuation
                else if (n === 0x0a) { /* line continuation */ }
                else if (n >= 0x30 && n <= 0x37) {
                    let oct = n - 0x30;
                    for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) oct = oct * 8 + (b[this.pos++] - 0x30);
                    out.push(oct & 0xff);
                } else out.push(n);
                continue;
            }
            if (c === 0x28) depth++;
            if (c === 0x29 && --depth === 0) break;
            out.push(c);
        }
        return Buffer.from(out);
    }

    readHexString() {
        const b = this.buf;
        this.pos++; // '<'
        let hex = '';
        while (this.pos < b.length && b[this.pos] !== 0x3e) {
            const ch = String.fromCharCode(b[this.pos++]);
            if (/[0-9a-fA-F]/.test(ch)) hex += ch;
        }
        this.pos++; // '>'
        if (hex.length % 2) hex += '0';
        return Buffer.from(hex, 'hex');
    }

    /** Inline image data: from just after `ID` to just past the `EI` that closes it. */
    skipInlineImageData() {
        const b = this.buf;
        if (isWhite(b[this.pos])) this.pos++;
        for (let i = this.pos; i < b.length - 1; i++) {
            if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === 0 || isWhite(b[i - 1]))
                && (i + 2 >= b.length || isWhite(b[i + 2]) || DELIMITERS.has(b[i + 2]))) {
                this.pos = i + 2;
                return true;
            }
        }
        this.pos = b.length;
        return false;
    }
}

/**
 * Turn a token stream into a nested operand value (arrays and dictionaries recurse).
 * Returns undefined for a closing token, so the caller can finish the container.
 */
function readValue(lexer, tok) {
    if (tok.type === 'value') return tok.value;
    if (tok.type === 'arrayOpen') {
        const arr = [];
        for (let t = lexer.next(); t && t.type !== 'arrayClose'; t = lexer.next()) {
            const v = readValue(lexer, t);
            if (v !== undefined) arr.push(v);
        }
        return arr;
    }
    if (tok.type === 'dictOpen') {
        const dict = {};
        let key = null;
        for (let t = lexer.next(); t && t.type !== 'dictClose'; t = lexer.next()) {
            const v = readValue(lexer, t);
            if (key === null) { key = v && v.name !== undefined ? v.name : String(v); continue; }
            dict[key] = v;
            key = null;
        }
        return { dict };
    }
    return undefined;
}

/**
 * Split a decoded content stream into operations: `{ op, operands, start, end }` where
 * [start, end) covers the operands and the operator, so cutting that range removes the
 * operation cleanly. `malformed` counts tokens that fit nowhere (junk, dangling operands).
 */
function parseOperations(buf) {
    const lexer = new ContentLexer(buf);
    const ops = [];
    let operands = [];
    let operandStart = -1;
    let malformed = 0;

    for (let tok = lexer.next(); tok; tok = lexer.next()) {
        if (tok.type === 'junk' || tok.type === 'arrayClose' || tok.type === 'dictClose') { malformed++; continue; }
        if (tok.type !== 'op') {
            if (operandStart < 0) operandStart = tok.start;
            const v = readValue(lexer, tok);
            if (v !== undefined) operands.push(v);
            continue;
        }
        const start = operandStart >= 0 ? operandStart : tok.start;
        if (tok.value === 'BI') {
            // Inline image: the key/value pairs up to ID, then raw bytes up to EI. One operation.
            const dict = {};
            let key = null;
            let t = lexer.next();
            for (; t && !(t.type === 'op' && t.value === 'ID'); t = lexer.next()) {
                const v = readValue(lexer, t);
                if (key === null) { key = v && v.name !== undefined ? v.name : String(v && v.value !== undefined ? v.value : v); continue; }
                dict[key] = v;
                key = null;
            }
            if (!t || !lexer.skipInlineImageData()) malformed++;
            ops.push({ op: 'BI', operands: [{ dict }], start, end: lexer.pos });
        } else {
            ops.push({ op: tok.value, operands, start, end: tok.end });
        }
        operands = [];
        operandStart = -1;
    }
    if (operands.length) malformed++;
    return { ops, malformed };
}

module.exports = { parseOperations, ContentLexer };
