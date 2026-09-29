'use strict';

/**
 * Interpret a page's content stream into drawable objects, each tied to the exact bytes that
 * draw it. Read-only: the page model says WHAT is on the page and WHERE; redactPdf cuts bytes.
 *
 * Coordinates are PDF user space (origin bottom-left, y up). A bbox is [x0, y0, x1, y1].
 */

const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } = require('pdf-lib');
const { parseOperations } = require('./contentLexer');
const { loadFont, streamBytes } = require('./pdfFonts');

const IDENTITY = [1, 0, 0, 1, 0, 0];
const CONSTRUCT = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const FILLS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const STROKES = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const MAX_FORM_DEPTH = 8;

const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function bboxOf(points) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of points) {
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
}

/** A colour operand list to 0-255 RGB; a pattern (name operand) or unknown space gives null. */
function toRgb(values) {
    const n = values.filter((v) => typeof v === 'number');
    if (n.length !== values.length) return null;
    const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    if (n.length === 1) return [c(n[0]), c(n[0]), c(n[0])];
    if (n.length === 3) return [c(n[0]), c(n[1]), c(n[2])];
    if (n.length === 4) {
        const [cy, m, y, k] = n;
        return [c((1 - cy) * (1 - k)), c((1 - m) * (1 - k)), c((1 - y) * (1 - k))];
    }
    return null;
}

/** Look a key up on a page node, walking /Parent for inheritable attributes. */
function inherited(context, node, key) {
    for (let n = node, hops = 0; n && hops < 32; hops++) {
        const v = n.get(PDFName.of(key));
        if (v !== undefined) return context.lookup(v);
        n = context.lookup(n.get(PDFName.of('Parent')));
        if (!(n instanceof PDFDict)) break;
    }
    return undefined;
}

/** The page's content streams, decoded and joined, plus the refs they came from. */
function readPageContent(context, pageNode) {
    const contents = pageNode.get(PDFName.of('Contents'));
    const resolved = context.lookup(contents);
    const parts = [];
    const refs = [];
    const list = resolved instanceof PDFArray ? resolved.asArray() : (contents ? [contents] : []);
    for (const item of list) {
        const stream = context.lookup(item);
        const bytes = stream ? streamBytes(stream) : null;
        if (!bytes) continue;
        parts.push(bytes);
        if (item instanceof PDFRef) refs.push(item);
    }
    // Streams may only be split at token boundaries, so a newline between them is always safe.
    const joined = [];
    parts.forEach((p, i) => { if (i) joined.push(Buffer.from('\n')); joined.push(p); });
    return { bytes: Buffer.concat(joined), refs };
}

class Interpreter {
    constructor(context, fontCache) {
        this.context = context;
        this.fontCache = fontCache;
        this.objects = [];
        this.malformed = 0;
    }

    font(resources, name) {
        const fonts = resources ? this.context.lookup(resources.get(PDFName.of('Font'))) : null;
        const ref = fonts instanceof PDFDict ? fonts.get(PDFName.of(name)) : undefined;
        if (!ref) return loadFont(this.context, undefined);
        const key = ref instanceof PDFRef ? ref.toString() : null;
        if (key && this.fontCache.has(key)) return this.fontCache.get(key);
        const f = loadFont(this.context, ref);
        if (key) this.fontCache.set(key, f);
        return f;
    }

    xobject(resources, name) {
        const xo = resources ? this.context.lookup(resources.get(PDFName.of('XObject'))) : null;
        return xo instanceof PDFDict ? this.context.lookup(xo.get(PDFName.of(name))) : undefined;
    }

    /**
     * Walk one content stream. `form` is the XObject name when we are inside a form: those
     * objects are visible to detection and verification but cannot be cut out of the page.
     */
    run(bytes, resources, baseCtm, form = null, depth = 0) {
        const { ops, malformed } = parseOperations(bytes);
        this.malformed += malformed;
        let gs = { ctm: baseCtm, fill: [0, 0, 0], stroke: [0, 0, 0], lineWidth: 1, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, font: null, size: 0 };
        const stack = [];
        let tm = IDENTITY; let tlm = IDENTITY;
        let path = null;

        const nums = (o) => o.operands.map((v) => (typeof v === 'number' ? v : NaN));
        const showText = (o, pieces) => {
            const f = gs.font || loadFont(this.context, undefined);
            let x = 0;
            let text = '';
            for (const piece of pieces) {
                if (typeof piece === 'number') { x -= (piece / 1000) * gs.size * gs.th; continue; }
                if (!piece || !piece.bytes) continue;
                for (const g of f.decode(piece.bytes)) {
                    text += g.text;
                    x += (g.width * gs.size + gs.tc + (g.isSpace ? gs.tw : 0)) * gs.th;
                }
            }
            const m = mul(tm, gs.ctm);
            const lo = f.descent * gs.size + gs.rise;
            const hi = f.ascent * gs.size + gs.rise;
            const corners = [apply(m, 0, lo), apply(m, x, lo), apply(m, 0, hi), apply(m, x, hi)];
            const scaleY = Math.hypot(m[2], m[3]);
            this.objects.push({
                kind: 'text', start: o.start, end: o.end, text, bbox: bboxOf(corners),
                origin: apply(m, 0, gs.rise), size: gs.size * scaleY, form, removable: !form,
            });
            tm = mul([1, 0, 0, 1, x, 0], tm);
        };

        for (const o of ops) {
            const op = o.op;
            if (CONSTRUCT.has(op)) {
                const v = nums(o);
                if (!path) path = { start: o.start, points: [], segments: 0, clip: false };
                if (op === 're' && v.length === 4) {
                    const [x, y, w, h] = v;
                    path.points.push(apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x, y + h), apply(gs.ctm, x + w, y + h));
                    path.segments += 4;
                } else {
                    for (let i = 0; i + 1 < v.length; i += 2) path.points.push(apply(gs.ctm, v[i], v[i + 1]));
                    if (op !== 'm') path.segments++;
                }
                continue;
            }
            if (op === 'W' || op === 'W*') { if (path) path.clip = true; continue; }
            if (PAINT.has(op)) {
                if (path && path.points.length && op !== 'n') {
                    const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
                    this.objects.push({
                        kind: 'path', start: path.start, end: o.end, bbox: bboxOf(path.points),
                        fill: FILLS.has(op) ? gs.fill : null, stroke: STROKES.has(op) ? gs.stroke : null,
                        lineWidth: gs.lineWidth * scale, segments: path.segments, clip: path.clip,
                        form, removable: !form && !path.clip,
                    });
                }
                path = null;
                continue;
            }
            switch (op) {
                case 'q': stack.push({ ...gs }); break;
                case 'Q': if (stack.length) gs = stack.pop(); break;
                case 'cm': { const v = nums(o); if (v.length === 6) gs.ctm = mul(v, gs.ctm); break; }
                case 'w': gs.lineWidth = nums(o)[0] || 0; break;
                case 'g': case 'rg': case 'k': case 'sc': case 'scn': gs.fill = toRgb(o.operands); break;
                case 'G': case 'RG': case 'K': case 'SC': case 'SCN': gs.stroke = toRgb(o.operands); break;
                case 'cs': gs.fill = [0, 0, 0]; break;
                case 'CS': gs.stroke = [0, 0, 0]; break;
                case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
                case 'Tf': {
                    const name = o.operands[0]?.name;
                    gs.font = name ? this.font(resources, name) : null;
                    gs.size = typeof o.operands[1] === 'number' ? o.operands[1] : 0;
                    break;
                }
                case 'Tc': gs.tc = nums(o)[0] || 0; break;
                case 'Tw': gs.tw = nums(o)[0] || 0; break;
                case 'Tz': gs.th = (nums(o)[0] ?? 100) / 100; break;
                case 'TL': gs.tl = nums(o)[0] || 0; break;
                case 'Ts': gs.rise = nums(o)[0] || 0; break;
                case 'Tm': { const v = nums(o); if (v.length === 6) { tm = v; tlm = v; } break; }
                case 'Td': case 'TD': {
                    const [tx, ty] = nums(o);
                    tlm = mul([1, 0, 0, 1, tx || 0, ty || 0], tlm); tm = tlm;
                    if (op === 'TD') gs.tl = -(ty || 0);
                    break;
                }
                case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; break;
                case 'Tj': showText(o, [o.operands[0]]); break;
                case 'TJ': showText(o, Array.isArray(o.operands[0]) ? o.operands[0] : []); break;
                case "'": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; showText(o, [o.operands[0]]); break;
                case '"': {
                    const [aw, ac] = nums(o);
                    gs.tw = aw || 0; gs.tc = ac || 0;
                    tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm;
                    showText(o, [o.operands[2]]);
                    break;
                }
                case 'Do': this.drawXObject(o, resources, gs.ctm, form, depth); break;
                case 'BI': {
                    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(gs.ctm, x, y));
                    this.objects.push({ kind: 'image', start: o.start, end: o.end, bbox: bboxOf(corners), name: null, inline: true, form, removable: !form });
                    break;
                }
                default: break;
            }
        }
    }

    drawXObject(o, resources, ctm, form, depth) {
        const name = o.operands[0]?.name;
        const xo = name ? this.xobject(resources, name) : undefined;
        const subtype = xo?.dict?.get(PDFName.of('Subtype'))?.asString?.();
        if (subtype === '/Image') {
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(ctm, x, y));
            this.objects.push({ kind: 'image', start: o.start, end: o.end, bbox: bboxOf(corners), name, inline: false, form, removable: !form });
            return;
        }
        if (subtype !== '/Form' || depth >= MAX_FORM_DEPTH) return;
        const matrixArr = this.context.lookup(xo.dict.get(PDFName.of('Matrix')));
        const matrix = matrixArr instanceof PDFArray
            ? matrixArr.asArray().map((v) => (this.context.lookup(v) instanceof PDFNumber ? this.context.lookup(v).asNumber() : 0))
            : IDENTITY;
        const formRes = this.context.lookup(xo.dict.get(PDFName.of('Resources')));
        const bytes = streamBytes(xo);
        if (!bytes) return;
        // A form draws with its own resources (or, per the old spec, the page's).
        this.run(bytes, formRes instanceof PDFDict ? formRes : resources, mul(matrix, ctm), form || name, depth + 1);
    }
}

/**
 * Model one page: its objects (text, paths, images; ids are indexes into `objects`), the joined
 * content bytes the byte ranges refer to, and the page geometry.
 */
function analyzePage(context, pageNode, fontCache = new Map()) {
    const resources = inherited(context, pageNode, 'Resources');
    const box = inherited(context, pageNode, 'MediaBox');
    const nums = box instanceof PDFArray ? box.asArray().map((v) => context.lookup(v)?.asNumber?.() ?? 0) : [0, 0, 612, 792];
    const [bx0, by0, bx1, by1] = nums;
    const { bytes, refs } = readPageContent(context, pageNode);
    const interp = new Interpreter(context, fontCache);
    interp.run(bytes, resources instanceof PDFDict ? resources : null, IDENTITY);
    interp.objects.forEach((obj, i) => { obj.id = i; });
    return {
        objects: interp.objects,
        malformed: interp.malformed,
        contentBytes: bytes,
        contentRefs: refs,
        resources: resources instanceof PDFDict ? resources : null,
        box: [Math.min(bx0, bx1), Math.min(by0, by1), Math.max(bx0, bx1), Math.max(by0, by1)],
    };
}

module.exports = { analyzePage, inherited, readPageContent, toRgb };
