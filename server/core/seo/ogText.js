// @typecheck
'use strict';
/**
 * Text as SVG outlines, for the generated share image (core/seo/ogCard.js).
 *
 * The server image has no system fonts, so an SVG <text> rendered by sharp
 * would come out blank. Instead the glyph outlines of two bundled faces
 * (assets/fonts: Inter for small text, Fraunces for the headline, both SIL OFL)
 * are read with fontkit, which the server already ships for PDF export, and
 * written as <path> data. Nothing here touches the network or the
 * filesystem beyond those two files.
 *
 * The bundled faces are Latin subsets: a character they lack is skipped, not
 * drawn as a box.
 *
 * The variable fonts are used at their default instance: fontkit cannot lay out
 * a variation instance of a WOFF2 font.
 */

const fs = require('node:fs');
const path = require('node:path');

const FILES = Object.freeze({
    heading: 'Fraunces-Variable.woff2',
    body: 'Inter-Variable.woff2',
});
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

/** @typedef {{ layout: (text: string) => { glyphs: any[], positions: any[], advanceWidth: number }, unitsPerEm: number }} Face */

/** @type {Map<string, Face>} */
const faces = new Map();

/** @param {'heading' | 'body'} name @returns {Face} */
function face(name) {
    let f = faces.get(name);
    if (!f) {
        // Required here, not at the top: the module is loaded by every page render for its version helper.
        const created = require('fontkit').create(fs.readFileSync(path.join(FONT_DIR, FILES[name])));
        f = /** @type {Face} */ (/** @type {unknown} */ (created));
        faces.set(name, f);
    }
    return f;
}

/**
 * Control characters and line breaks become spaces; runs of space collapse.
 * @param {string | undefined} text
 */
function clean(text) {
    return String(text ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Width in px of `text` set at `size` px. @param {'heading' | 'body'} name
 * @param {string} text
 * @param {number} size
 */
function measure(name, text, size) {
    const f = face(name);
    return (f.layout(clean(text)).advanceWidth * size) / f.unitsPerEm;
}

/** Longest text laid out: a title beyond this is cut with an ellipsis (also bounds the work per card). */
const MAX_CHARS = 200;

/**
 * Break `text` into at most `maxLines` lines no wider than `maxWidth`. What
 * does not fit (or lies beyond MAX_CHARS) ends the last line with an ellipsis
 * and sets `truncated`. A word wider than the line is cut at the character,
 * found by binary search (one layout per probe), and work stops at the line
 * limit, so the cost is bounded whatever the text.
 * @param {'heading' | 'body'} name
 * @returns {{ lines: string[], truncated: boolean }}
 * @param {string} text
 * @param {number} size
 * @param {number} maxWidth
 * @param {number} maxLines
 */
function wrapLines(name, text, size, maxWidth, maxLines) {
    const all = clean(text);
    let truncated = all.length > MAX_CHARS;
    const words = all.slice(0, MAX_CHARS).split(' ').filter(Boolean);
    /** @type {string[]} */
    const lines = [];
    let line = '';
    /**
     * @param {string} str
     */
    const fits = (str) => measure(name, str, size) <= maxWidth;
    const full = () => lines.length >= maxLines;
    outer: for (let word of words) {
        while (word.length > 1 && !fits(word)) {
            let lo = 1;
            let hi = word.length - 1; // largest cut that fits, at least 1
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (fits(word.slice(0, mid))) lo = mid; else hi = mid - 1;
            }
            if (line) { lines.push(line); line = ''; if (full()) { truncated = true; break outer; } }
            lines.push(word.slice(0, lo));
            if (full()) { truncated = true; break outer; }
            word = word.slice(lo);
        }
        const next = line ? `${line} ${word}` : word;
        if (fits(next)) { line = next; continue; }
        lines.push(line);
        line = word;
        if (full()) { truncated = true; line = ''; break; }
    }
    if (line) {
        if (full()) truncated = true; else lines.push(line);
    }
    if (truncated && lines.length) {
        let last = `${lines[lines.length - 1]}…`;
        while (last.length > 2 && !fits(last)) last = `${last.slice(0, -2)}…`;
        lines[lines.length - 1] = last;
    }
    return { lines, truncated };
}

/**
 * @param {'heading' | 'body'} name @returns {string[]}
 * @param {string} text
 * @param {number} size
 * @param {number} maxWidth
 * @param {number} maxLines
 */
const wrap = (name, text, size, maxWidth, maxLines) => wrapLines(name, text, size, maxWidth, maxLines).lines;

/**
 * @param {number} v
 */
const n = (v) => (Math.round(v * 10) / 10).toString();

/**
 * SVG path data for `text`, left edge at x, baseline at y.
 * @param {'heading' | 'body'} name
 * @param {string} text
 * @param {number} size
 * @param {number} x
 * @param {number} y
 */
function textPath(name, text, size, x, y) {
    const f = face(name);
    const scale = size / f.unitsPerEm;
    const run = f.layout(clean(text));
    let pen = x;
    /** @type {string[]} */
    const out = [];
    run.glyphs.forEach((glyph, i) => {
        const pos = run.positions[i];
        if (glyph.id !== 0) {
            const ox = pen + pos.xOffset * scale;
            const oy = y - pos.yOffset * scale;
            for (const { command, args } of glyph.path.commands) {
                const pts = args.map((/** @type {number} */ v, /** @type {number} */ k) => n(k % 2 === 0 ? ox + v * scale : oy - v * scale));
                if (command === 'moveTo') out.push(`M${pts[0]} ${pts[1]}`);
                else if (command === 'lineTo') out.push(`L${pts[0]} ${pts[1]}`);
                else if (command === 'quadraticCurveTo') out.push(`Q${pts[0]} ${pts[1]} ${pts[2]} ${pts[3]}`);
                else if (command === 'bezierCurveTo') out.push(`C${pts.slice(0, 6).join(' ')}`);
                else if (command === 'closePath') out.push('Z');
            }
        }
        pen += pos.xAdvance * scale;
    });
    return out.join('');
}

module.exports = { measure, wrap, wrapLines, textPath, clean, MAX_CHARS };
