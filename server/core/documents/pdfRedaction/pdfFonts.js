'use strict';

/**
 * Just enough font handling to read what a text operator says and how wide it is.
 *
 * Redaction needs the Unicode text of every show operator (to decide whether it names the
 * customer) and its advance (to know where it sits). Glyph outlines are never touched.
 */

const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } = require('pdf-lib');

const WIN_ANSI_EXTRAS = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
    0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
    0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
    0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

// Glyph names a /Differences array commonly uses; anything else falls back to the code itself.
const GLYPH_NAMES = {
    space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
    quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
    period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?',
    at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', underscore: '_', braceleft: '{', bar: '|',
    braceright: '}', degree: '°', plusminus: '±', multiply: '×', Oslash: 'Ø', oslash: 'ø', endash: '–',
    emdash: '—', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9',
};

function glyphNameToText(name) {
    if (GLYPH_NAMES[name]) return GLYPH_NAMES[name];
    if (/^[A-Za-z]$/.test(name)) return name;
    const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
    if (uni) return String.fromCharCode(parseInt(uni[1], 16));
    return '';
}

function streamBytes(obj) {
    if (obj instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(obj).decode());
    if (obj instanceof PDFStream && typeof obj.getContents === 'function') return Buffer.from(obj.getContents());
    return null;
}

function utf16beToString(hex) {
    const bytes = Buffer.from(hex, 'hex');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
}

/** Parse a ToUnicode CMap into `{ ranges: [{lo, hi, len}], map: Map<code, string> }`. */
function parseToUnicode(buf) {
    const text = buf.toString('latin1');
    const ranges = [];
    const map = new Map();

    for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
        for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
            ranges.push({ lo: parseInt(m[1], 16), hi: parseInt(m[2], 16), len: m[1].length / 2 });
        }
    }
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
            map.set(parseInt(m[1], 16), utf16beToString(m[2]));
        }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        const body = block[1];
        const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
        for (const m of body.matchAll(re)) {
            const lo = parseInt(m[1], 16);
            const hi = parseInt(m[2], 16);
            if (hi - lo > 0xffff) continue;
            if (m[4] !== undefined) {
                const dsts = [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((d) => utf16beToString(d[1]));
                for (let c = lo; c <= hi && c - lo < dsts.length; c++) map.set(c, dsts[c - lo]);
            } else {
                const base = Buffer.from(m[3], 'hex');
                for (let c = lo; c <= hi; c++) {
                    const dst = Buffer.from(base);
                    // Increment the last byte pair by the offset in the range.
                    const off = c - lo;
                    const last = dst.length >= 2 ? ((dst[dst.length - 2] << 8) | dst[dst.length - 1]) + off : off;
                    if (dst.length >= 2) { dst[dst.length - 2] = (last >> 8) & 0xff; dst[dst.length - 1] = last & 0xff; }
                    map.set(c, utf16beToString(dst.toString('hex')));
                }
            }
        }
    }
    return { ranges, map };
}

function num(obj, fallback) {
    return obj instanceof PDFNumber ? obj.asNumber() : fallback;
}

/** CID widths from a /W array: `c [w1 w2 …]` or `cFirst cLast w`. */
function parseCidWidths(context, wArr) {
    const widths = new Map();
    if (!(wArr instanceof PDFArray)) return widths;
    const items = wArr.asArray().map((x) => context.lookup(x));
    for (let i = 0; i < items.length;) {
        const first = num(items[i], null);
        const next = items[i + 1];
        if (first === null) { i++; continue; }
        if (next instanceof PDFArray) {
            next.asArray().forEach((w, k) => widths.set(first + k, num(context.lookup(w), 1000)));
            i += 2;
        } else {
            const last = num(next, first);
            const w = num(items[i + 2], 1000);
            for (let c = first; c <= last && c - first < 0x10000; c++) widths.set(c, w);
            i += 3;
        }
    }
    return widths;
}

/**
 * A decoder for one font dictionary: `decode(bytes)` returns the glyphs a string draws, each
 * `{ text, width, isSpace }` with width in text space units per 1 unit of font size.
 */
function loadFont(context, fontDictOrRef) {
    const dict = context.lookup(fontDictOrRef);
    if (!(dict instanceof PDFDict)) return fallbackFont();
    const subtype = dict.get(PDFName.of('Subtype'))?.asString?.() || '';

    let toUnicode = null;
    const tu = context.lookup(dict.get(PDFName.of('ToUnicode')));
    const tuBytes = tu ? streamBytes(tu) : null;
    if (tuBytes) toUnicode = parseToUnicode(tuBytes);

    let descriptor = context.lookup(dict.get(PDFName.of('FontDescriptor')));
    let widthOf;
    let codeLengths;
    let unitScale = 1 / 1000;

    if (subtype === '/Type0') {
        const desc = context.lookup(dict.get(PDFName.of('DescendantFonts')));
        const cidFont = desc instanceof PDFArray ? context.lookup(desc.get(0)) : null;
        const dw = cidFont ? num(context.lookup(cidFont.get(PDFName.of('DW'))), 1000) : 1000;
        const widths = cidFont ? parseCidWidths(context, context.lookup(cidFont.get(PDFName.of('W')))) : new Map();
        if (cidFont && !descriptor) descriptor = context.lookup(cidFont.get(PDFName.of('FontDescriptor')));
        widthOf = (code) => (widths.has(code) ? widths.get(code) : dw);
        // Identity-H and nearly every other CJK/CID encoding use 2-byte codes; the ToUnicode
        // codespace, when it says otherwise, is the better witness.
        codeLengths = toUnicode && toUnicode.ranges.length ? toUnicode.ranges : [{ lo: 0, hi: 0xffff, len: 2 }];
    } else {
        const firstChar = num(context.lookup(dict.get(PDFName.of('FirstChar'))), 0);
        const wArr = context.lookup(dict.get(PDFName.of('Widths')));
        const widths = wArr instanceof PDFArray ? wArr.asArray().map((w) => num(context.lookup(w), 0)) : [];
        if (subtype === '/Type3') {
            const fm = context.lookup(dict.get(PDFName.of('FontMatrix')));
            if (fm instanceof PDFArray) unitScale = num(context.lookup(fm.get(0)), 0.001);
        }
        widthOf = (code) => {
            const w = widths[code - firstChar];
            return typeof w === 'number' && w > 0 ? w : 500;
        };
        codeLengths = [{ lo: 0, hi: 0xff, len: 1 }];
    }

    const simpleText = subtype === '/Type0' ? null : buildSimpleEncoding(context, dict);
    const ascent = descriptor ? num(context.lookup(descriptor.get(PDFName.of('Ascent'))), 800) : 800;
    const descent = descriptor ? num(context.lookup(descriptor.get(PDFName.of('Descent'))), -200) : -200;

    function readCode(bytes, i) {
        for (const r of codeLengths) {
            if (i + r.len > bytes.length) continue;
            let code = 0;
            for (let k = 0; k < r.len; k++) code = (code << 8) | bytes[i + k];
            if (code >= r.lo && code <= r.hi) return { code, len: r.len };
        }
        return { code: bytes[i], len: 1 };
    }

    return {
        ascent: (ascent || 800) / 1000,
        descent: (descent || -200) / 1000,
        decode(bytes) {
            const glyphs = [];
            for (let i = 0; i < bytes.length;) {
                const { code, len } = readCode(bytes, i);
                i += len;
                let text = toUnicode?.map.get(code);
                if (text === undefined) text = simpleText ? simpleText(code) : '';
                glyphs.push({
                    text,
                    width: widthOf(code) * unitScale,
                    // Word spacing applies to the single-byte code 32 only, never to a 2-byte code.
                    isSpace: len === 1 && code === 32,
                });
            }
            return glyphs;
        },
    };
}

function buildSimpleEncoding(context, dict) {
    const enc = context.lookup(dict.get(PDFName.of('Encoding')));
    const differences = new Map();
    let base = 'WinAnsiEncoding';
    if (enc instanceof PDFDict) {
        const b = enc.get(PDFName.of('BaseEncoding'));
        if (b) base = b.decodeText();
        const diff = context.lookup(enc.get(PDFName.of('Differences')));
        if (diff instanceof PDFArray) {
            let code = 0;
            for (const item of diff.asArray()) {
                const v = context.lookup(item);
                if (v instanceof PDFNumber) code = v.asNumber();
                else if (v?.decodeText) differences.set(code++, glyphNameToText(v.decodeText()));
            }
        }
    } else if (enc?.decodeText) {
        base = enc.decodeText();
    }
    return (code) => {
        if (differences.has(code)) return differences.get(code);
        if (base === 'WinAnsiEncoding' && WIN_ANSI_EXTRAS[code]) return String.fromCharCode(WIN_ANSI_EXTRAS[code]);
        return code >= 0x20 ? String.fromCharCode(code) : '';
    };
}

function fallbackFont() {
    return {
        ascent: 0.8,
        descent: -0.2,
        decode: (bytes) => [...bytes].map((c) => ({ text: c >= 0x20 ? String.fromCharCode(c) : '', width: 0.5, isSpace: c === 32 })),
    };
}

module.exports = { loadFont, parseToUnicode, streamBytes };
