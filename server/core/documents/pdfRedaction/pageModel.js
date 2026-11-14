// @typecheck
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

/** @typedef {import('pdf-lib').PDFContext} PDFContext */
/** @typedef {import('./pdfFonts').PdfFont} PdfFont */
/** @typedef {import('./contentLexer').PdfOperation} PdfOperation */
/** @typedef {import('./contentLexer').PdfOperand} PdfOperand */
/**
 * One drawable object on a page; `id` is its index in the page's `objects`.
 * @typedef {{
 *   kind: 'text'|'path'|'image',
 *   id?: number,
 *   start: number,
 *   end: number,
 *   bbox: number[],
 *   text?: string,
 *   origin?: number[],
 *   size?: number,
 *   fill?: number[]|null,
 *   stroke?: number[]|null,
 *   lineWidth?: number,
 *   segments?: number,
 *   clip?: boolean,
 *   name?: string|null,
 *   inline?: boolean,
 *   form: string|null,
 *   removable: boolean,
 * }} PageObject
 */

const mul = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (/** @type {number[]} */ m, /** @type {number} */ x, /** @type {number} */ y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** @param {number[][]} points */
function bboxOf(points) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of points) {
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
}

/**
 * A colour operand list to 0-255 RGB; a pattern (name operand) or unknown space gives null.
 * @param {unknown[]} values
 */
function toRgb(values) {
    const n = values.filter((v) => typeof v === 'number');
    if (n.length !== values.length) return null;
    const c = (/** @type {number} */ v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    if (n.length === 1) return [c(n[0]), c(n[0]), c(n[0])];
    if (n.length === 3) return [c(n[0]), c(n[1]), c(n[2])];
    if (n.length === 4) {
        const [cy, m, y, k] = n;
        return [c((1 - cy) * (1 - k)), c((1 - m) * (1 - k)), c((1 - y) * (1 - k))];
    }
    return null;
}

/**
 * Look a key up on a page node, walking /Parent for inheritable attributes.
 * @param {PDFContext} context
 * @param {import('./pdfFonts').PdfObjectView} node
 * @param {string} key
 */
function inherited(context, node, key) {
    for (let n = node, hops = 0; n && hops < 32; hops++) {
        const v = n.get(PDFName.of(key));
        if (v !== undefined) return context.lookup(v);
        n = context.lookup(n.get(PDFName.of('Parent')));
        if (!(n instanceof PDFDict)) break;
    }
    return undefined;
}

/**
 * The page's content streams, decoded and joined, plus the refs they came from.
 * @param {PDFContext} context
 * @param {import('pdf-lib').PDFDict} pageNode
 */
function readPageContent(context, pageNode) {
    const contents = pageNode.get(PDFName.of('Contents'));
    const resolved = context.lookup(contents);
    /** @type {Buffer[]} */
    const parts = [];
    /** @type {import('pdf-lib').PDFRef[]} */
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
    /** @type {Buffer[]} */
    const joined = [];
    parts.forEach((p, i) => { if (i) joined.push(Buffer.from('\n')); joined.push(p); });
    return { bytes: Buffer.concat(joined), refs };
}

/**
 * @typedef {{ ctm: number[], fill: number[]|null, stroke: number[]|null, lineWidth: number, tc: number, tw: number, th: number, tl: number, rise: number, font: PdfFont|null, size: number }} GraphicsState
 * @typedef {{ start: number, points: number[][], segments: number, clip: boolean }} PathUnderConstruction
 * The interpreter's state while it walks one content stream.
 * @typedef {{ gs: GraphicsState, stack: GraphicsState[], tm: number[], tlm: number[], path: PathUnderConstruction|null,
 *   resources: import('pdf-lib').PDFDict|null, form: string|null, depth: number }} RunState
 * @typedef {(interp: Interpreter, st: RunState, o: PdfOperation) => void} OperatorHandler
 */

/** An operation's operands as numbers; a non-number operand is NaN. */
const nums = (/** @type {PdfOperation} */ o) => o.operands.map((v) => (typeof v === 'number' ? v : NaN));

/** Move to the start of the next text line (T*, and before ' and "). @param {RunState} st */
function nextLine(st) {
    st.tlm = mul([1, 0, 0, 1, 0, -st.gs.tl], st.tlm);
    st.tm = st.tlm;
}

/** @type {OperatorHandler} */
const setFill = (_i, st, o) => { st.gs.fill = toRgb(o.operands); };
/** @type {OperatorHandler} */
const setStroke = (_i, st, o) => { st.gs.stroke = toRgb(o.operands); };
/** @type {OperatorHandler} */
const moveText = (_i, st, o) => {
    const [tx, ty] = nums(o);
    st.tlm = mul([1, 0, 0, 1, tx || 0, ty || 0], st.tlm); st.tm = st.tlm;
    if (o.op === 'TD') st.gs.tl = -(ty || 0);
};

/**
 * The graphics-state, text-state and drawing operators (path construction and
 * painting are handled before this table). An operator not in it is ignored.
 * @type {Map<string, OperatorHandler>}
 */
const OPERATORS = new Map(/** @type {Array<[string, OperatorHandler]>} */ ([
    ['q', (_i, st) => { st.stack.push({ ...st.gs }); }],
    ['Q', (_i, st) => { if (st.stack.length) st.gs = /** @type {GraphicsState} */ (st.stack.pop()); }],
    ['cm', (_i, st, o) => { const v = nums(o); if (v.length === 6) st.gs.ctm = mul(v, st.gs.ctm); }],
    ['w', (_i, st, o) => { st.gs.lineWidth = nums(o)[0] || 0; }],
    ...['g', 'rg', 'k', 'sc', 'scn'].map((op) => /** @type {[string, OperatorHandler]} */ ([op, setFill])),
    ...['G', 'RG', 'K', 'SC', 'SCN'].map((op) => /** @type {[string, OperatorHandler]} */ ([op, setStroke])),
    ['cs', (_i, st) => { st.gs.fill = [0, 0, 0]; }],
    ['CS', (_i, st) => { st.gs.stroke = [0, 0, 0]; }],
    ['BT', (_i, st) => { st.tm = IDENTITY; st.tlm = IDENTITY; }],
    ['Tf', (interp, st, o) => {
        const name = /** @type {{ name?: string } | undefined} */ (o.operands[0])?.name;
        st.gs.font = name ? interp.font(st.resources, name) : null;
        st.gs.size = typeof o.operands[1] === 'number' ? o.operands[1] : 0;
    }],
    ['Tc', (_i, st, o) => { st.gs.tc = nums(o)[0] || 0; }],
    ['Tw', (_i, st, o) => { st.gs.tw = nums(o)[0] || 0; }],
    ['Tz', (_i, st, o) => { st.gs.th = (nums(o)[0] ?? 100) / 100; }],
    ['TL', (_i, st, o) => { st.gs.tl = nums(o)[0] || 0; }],
    ['Ts', (_i, st, o) => { st.gs.rise = nums(o)[0] || 0; }],
    ['Tm', (_i, st, o) => { const v = nums(o); if (v.length === 6) { st.tm = v; st.tlm = v; } }],
    ['Td', moveText],
    ['TD', moveText],
    ['T*', (_i, st) => { nextLine(st); }],
    ['Tj', (interp, st, o) => { interp.showText(st, o, [o.operands[0]]); }],
    ['TJ', (interp, st, o) => { interp.showText(st, o, Array.isArray(o.operands[0]) ? o.operands[0] : []); }],
    ["'", (interp, st, o) => { nextLine(st); interp.showText(st, o, [o.operands[0]]); }],
    ['"', (interp, st, o) => {
        const [aw, ac] = nums(o);
        st.gs.tw = aw || 0; st.gs.tc = ac || 0;
        nextLine(st);
        interp.showText(st, o, [o.operands[2]]);
    }],
    ['Do', (interp, st, o) => { interp.drawXObject(o, st.resources, st.gs.ctm, st.form, st.depth); }],
    ['BI', (interp, st, o) => {
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(st.gs.ctm, x, y));
        interp.objects.push({ kind: 'image', start: o.start, end: o.end, bbox: bboxOf(corners), name: null, inline: true, form: st.form, removable: !st.form });
    }],
]));

class Interpreter {
    /**
     * @param {PDFContext} context
     * @param {Map<string, PdfFont>} fontCache
     */
    constructor(context, fontCache) {
        this.context = context;
        this.fontCache = fontCache;
        /** @type {PageObject[]} */
        this.objects = [];
        this.malformed = 0;
    }

    /**
     * @param {import('pdf-lib').PDFDict|null} resources
     * @param {string} name
     * @returns {PdfFont}
     */
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

    /**
     * @param {import('pdf-lib').PDFDict|null} resources
     * @param {string} name
     * @returns {(import('pdf-lib').PDFObject & { dict?: import('pdf-lib').PDFDict }) | undefined}
     */
    xobject(resources, name) {
        const xo = resources ? this.context.lookup(resources.get(PDFName.of('XObject'))) : null;
        return xo instanceof PDFDict ? this.context.lookup(xo.get(PDFName.of(name))) : undefined;
    }

    /**
     * Walk one content stream. `form` is the XObject name when we are inside a form: those
     * objects are visible to detection and verification but cannot be cut out of the page.
     * @param {Buffer} bytes
     * @param {import('pdf-lib').PDFDict|null} resources
     * @param {number[]} baseCtm
     * @param {string|null} [form]
     * @param {number} [depth]
     */
    run(bytes, resources, baseCtm, form = null, depth = 0) {
        const { ops, malformed } = parseOperations(bytes);
        this.malformed += malformed;
        /** @type {RunState} */
        const st = {
            gs: { ctm: baseCtm, fill: [0, 0, 0], stroke: [0, 0, 0], lineWidth: 1, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, font: null, size: 0 },
            stack: [], tm: IDENTITY, tlm: IDENTITY, path: null, resources, form, depth,
        };
        for (const o of ops) {
            if (CONSTRUCT.has(o.op)) this.constructPath(st, o);
            else if (o.op === 'W' || o.op === 'W*') { if (st.path) st.path.clip = true; }
            else if (PAINT.has(o.op)) this.paintPath(st, o);
            else OPERATORS.get(o.op)?.(this, st, o);
        }
    }

    /**
     * A path construction operator: start the path or extend it, in device space.
     * @param {RunState} st
     * @param {PdfOperation} o
     */
    constructPath(st, o) {
        const v = nums(o);
        const ctm = st.gs.ctm;
        if (!st.path) st.path = { start: o.start, points: [], segments: 0, clip: false };
        const path = st.path;
        if (o.op === 're' && v.length === 4) {
            const [x, y, w, h] = v;
            path.points.push(apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x, y + h), apply(ctm, x + w, y + h));
            path.segments += 4;
            return;
        }
        for (let i = 0; i + 1 < v.length; i += 2) path.points.push(apply(ctm, v[i], v[i + 1]));
        if (o.op !== 'm') path.segments++;
    }

    /**
     * A painting operator ends the path; anything but `n` on a non-empty path is
     * a path object. A clipping path stays on the page.
     * @param {RunState} st
     * @param {PdfOperation} o
     */
    paintPath(st, o) {
        const { path, gs } = st;
        if (path && path.points.length && o.op !== 'n') {
            const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
            this.objects.push({
                kind: 'path', start: path.start, end: o.end, bbox: bboxOf(path.points),
                fill: FILLS.has(o.op) ? gs.fill : null, stroke: STROKES.has(o.op) ? gs.stroke : null,
                lineWidth: gs.lineWidth * scale, segments: path.segments, clip: path.clip,
                form: st.form, removable: !st.form && !path.clip,
            });
        }
        st.path = null;
    }

    /**
     * A text-showing operator: one text object over the advance of its glyphs,
     * then the text matrix moves past it.
     * @param {RunState} st
     * @param {PdfOperation} o
     * @param {PdfOperand[]} pieces
     */
    showText(st, o, pieces) {
        const gs = st.gs;
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
        const m = mul(st.tm, gs.ctm);
        const lo = f.descent * gs.size + gs.rise;
        const hi = f.ascent * gs.size + gs.rise;
        const corners = [apply(m, 0, lo), apply(m, x, lo), apply(m, 0, hi), apply(m, x, hi)];
        const scaleY = Math.hypot(m[2], m[3]);
        this.objects.push({
            kind: 'text', start: o.start, end: o.end, text, bbox: bboxOf(corners),
            origin: apply(m, 0, gs.rise), size: gs.size * scaleY, form: st.form, removable: !st.form,
        });
        st.tm = mul([1, 0, 0, 1, x, 0], st.tm);
    }

    /**
     * @param {PdfOperation} o
     * @param {import('pdf-lib').PDFDict|null} resources
     * @param {number[]} ctm
     * @param {string|null} form
     * @param {number} depth
     */
    drawXObject(o, resources, ctm, form, depth) {
        const name = o.operands[0]?.name;
        const xo = name ? this.xobject(resources, name) : undefined;
        const subtype = /** @type {import('pdf-lib').PDFObject & { asString?: () => string }} */ (xo?.dict?.get(PDFName.of('Subtype')))?.asString?.();
        if (subtype === '/Image') {
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(ctm, x, y));
            this.objects.push({ kind: 'image', start: o.start, end: o.end, bbox: bboxOf(corners), name, inline: false, form, removable: !form });
            return;
        }
        if (subtype !== '/Form' || depth >= MAX_FORM_DEPTH) return;
        const matrixArr = this.context.lookup(xo.dict.get(PDFName.of('Matrix')));
        const matrix = matrixArr instanceof PDFArray
            ? matrixArr.asArray().map((v) => (this.context.lookup(v) instanceof PDFNumber ? /** @type {import('pdf-lib').PDFNumber} */ (this.context.lookup(v)).asNumber() : 0))
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
 * @param {PDFContext} context
 * @param {import('pdf-lib').PDFDict} pageNode
 * @param {Map<string, PdfFont>} [fontCache]
 */
function analyzePage(context, pageNode, fontCache = new Map()) {
    const resources = inherited(context, pageNode, 'Resources');
    const box = inherited(context, pageNode, 'MediaBox');
    const nums = box instanceof PDFArray ? box.asArray().map((v) => /** @type {import('pdf-lib').PDFObject & { asNumber?: () => number }} */ (context.lookup(v))?.asNumber?.() ?? 0) : [0, 0, 612, 792];
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
