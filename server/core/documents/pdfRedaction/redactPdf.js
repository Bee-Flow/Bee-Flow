'use strict';

/**
 * Remove the marks that identify a person or the customer from a PDF, and nothing else.
 *
 * Nothing on a page is re-generated: the operators that draw a mark are cut out of the content
 * stream and every other byte stays as it was, so dimensions, fonts and line work cannot shift.
 * (Re-generating pages is how a naive redactor turns "45°" into "78".) Document metadata,
 * links and orphaned objects go too. The result is re-read and checked before it is returned;
 * anything unexpected refuses the file instead of returning a half-cleaned one.
 */

const {
    PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString,
} = require('pdf-lib');
const { analyzePage } = require('./pageModel');
const { detectMarks, deriveTerms, textReason, norm } = require('./detectMarks');
const { streamBytes } = require('./pdfFonts');

const MAX_PAGES = 200;

class PdfRedactionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PdfRedactionError';
        this.code = code;
    }
}

async function loadPdf(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 1024).includes('%PDF-')) {
        throw new PdfRedactionError('not_pdf', 'This file is not a PDF.');
    }
    let doc;
    try {
        doc = await PDFDocument.load(buffer, { updateMetadata: false });
    } catch (err) {
        if (/encrypt/i.test(String(err && (err.name + err.message)))) {
            throw new PdfRedactionError('encrypted', 'This PDF is encrypted or password-protected, so it cannot be cleaned.');
        }
        throw new PdfRedactionError('unreadable', 'This PDF could not be read.');
    }
    if (doc.context.trailerInfo.Encrypt) {
        throw new PdfRedactionError('encrypted', 'This PDF is encrypted or password-protected, so it cannot be cleaned.');
    }
    if (doc.getPageCount() > MAX_PAGES) {
        throw new PdfRedactionError('too_many_pages', `This PDF has more than ${MAX_PAGES} pages.`);
    }
    return doc;
}

function analyzeDocument(doc) {
    const fontCache = new Map();
    return doc.getPages().map((p, index) => ({ index, node: p.node, ...analyzePage(doc.context, p.node, fontCache) }));
}

function termsFor(pages, userTerms) {
    const texts = pages.flatMap((p) => p.objects.filter((o) => o.kind === 'text').map((o) => o.text));
    const all = [...(userTerms || []).map(norm), ...deriveTerms(texts).map(norm)].filter((t) => t.length >= 3);
    return [...new Set(all)];
}

/**
 * The readable text runs of a PDF, for an AI pass that picks the ones naming a person or the
 * customer. `ref` ("p1-12") is what the AI answers with; position is a coarse hint.
 */
async function listTextRuns(buffer, { max = 800 } = {}) {
    const doc = await loadPdf(buffer);
    const pages = analyzeDocument(doc);
    const runs = [];
    for (const p of pages) {
        const [bx0, by0, bx1, by1] = p.box;
        for (const o of p.objects) {
            if (o.kind !== 'text' || !o.text.trim()) continue;
            const fx = ((o.bbox[0] + o.bbox[2]) / 2 - bx0) / Math.max(bx1 - bx0, 1);
            const fy = (by1 - (o.bbox[1] + o.bbox[3]) / 2) / Math.max(by1 - by0, 1);
            runs.push({
                ref: `p${p.index + 1}-${o.id}`, page: p.index + 1, id: o.id, text: o.text.trim().slice(0, 200),
                position: `${fy < 0.33 ? 'top' : fy < 0.66 ? 'middle' : 'bottom'}-${fx < 0.33 ? 'left' : fx < 0.66 ? 'center' : 'right'}`,
            });
            if (runs.length >= max) return { runs, truncated: true, pageCount: pages.length };
        }
    }
    return { runs, truncated: false, pageCount: pages.length };
}

/** Cut [start, end) ranges out of a content stream; each cut leaves one space so tokens never glue. */
function cutRanges(bytes, ranges) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const parts = [];
    let pos = 0;
    for (const [s, e] of sorted) {
        if (s < pos) continue; // overlaps a range already cut
        parts.push(bytes.subarray(pos, s), Buffer.from(' '));
        pos = e;
    }
    parts.push(bytes.subarray(pos));
    return Buffer.concat(parts);
}

function annotationText(context, annot) {
    return ['Contents', 'T', 'Subj', 'RC', 'TU']
        .map((k) => context.lookup(annot.get(PDFName.of(k))))
        .filter((v) => v instanceof PDFString || v instanceof PDFHexString)
        .map((v) => v.decodeText())
        .join(' ');
}

/** Drop links (their URIs name the owner) and any annotation whose text identifies someone. */
function cleanAnnotations(context, pageNode, terms) {
    const annots = context.lookup(pageNode.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) return 0;
    const keep = [];
    let removed = 0;
    for (const ref of annots.asArray()) {
        const a = context.lookup(ref);
        const subtype = a instanceof PDFDict ? a.get(PDFName.of('Subtype'))?.asString?.() : null;
        if (subtype === '/Link' || (a instanceof PDFDict && textReason(annotationText(context, a), terms))) { removed++; continue; }
        keep.push(ref);
    }
    // A pdf-lib PDFDict entry on the page, not an HTTP header.
    if (removed) pageNode.set(PDFName.of('Annots'), context.obj(keep)); // nosemgrep: ajinabraham.njsscan.headers.header_injection.generic_header_injection
    return removed;
}

/** Delete every indirect object that is no longer reachable from the catalog. */
function collectGarbage(context) {
    const seen = new Set();
    const stack = [context.trailerInfo.Root];
    while (stack.length) {
        const item = stack.pop();
        if (!item) continue;
        if (item instanceof PDFRef) {
            const key = item.toString();
            if (seen.has(key)) continue;
            seen.add(key);
            stack.push(context.lookup(item));
        } else if (item instanceof PDFDict) {
            stack.push(...item.values());
        } else if (item instanceof PDFArray) {
            stack.push(...item.asArray());
        } else if (item instanceof PDFStream) {
            stack.push(item.dict);
        }
    }
    let deleted = 0;
    for (const [ref] of context.enumerateIndirectObjects()) {
        if (!seen.has(ref.toString())) { context.delete(ref); deleted++; }
    }
    return deleted;
}

function scrubDocument(doc) {
    const { context } = doc;
    context.trailerInfo.Info = undefined;
    const catalog = doc.catalog;
    for (const key of ['Metadata', 'PieceInfo']) catalog.delete(PDFName.of(key));
    const names = context.lookup(catalog.get(PDFName.of('Names')));
    if (names instanceof PDFDict) {
        names.delete(PDFName.of('EmbeddedFiles'));
        names.delete(PDFName.of('JavaScript'));
    }
}

/** Every decoded stream and string in a saved PDF, lower-cased, for a last leak search. */
async function rawText(buffer) {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    const chunks = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFStream) {
            try { const b = streamBytes(obj); if (b) chunks.push(b.toString('latin1')); } catch { /* undecodable filter: its raw bytes are below */ }
        }
        chunks.push(obj.toString());
    }
    return chunks.join('\n').toLowerCase();
}

function textMultiset(objects) {
    return objects.filter((o) => o.kind === 'text').map((o) => o.text.trim()).filter(Boolean).sort();
}

/**
 * Re-read the output and prove it: the text left is exactly the original minus what we cut,
 * no path or image vanished that we did not cut, nothing the rules flag is left, and no
 * customer term survives anywhere in the file's bytes.
 */
async function verify(outBuffer, before, removedIds, terms, removedTexts) {
    const doc = await loadPdf(outBuffer);
    const after = analyzeDocument(doc);
    if (after.length !== before.length) throw new PdfRedactionError('verification_failed', 'The page count changed.');
    for (const page of after) {
        const orig = before[page.index];
        const cut = removedIds[page.index];
        const expected = orig.objects.filter((o) => !cut.has(o.id));
        const a = textMultiset(page.objects);
        const e = textMultiset(expected);
        if (a.length !== e.length || a.some((t, i) => t !== e[i])) {
            throw new PdfRedactionError('verification_failed', `Page ${page.index + 1}: text changed beyond what was removed.`);
        }
        for (const kind of ['path', 'image']) {
            if (page.objects.filter((o) => o.kind === kind).length !== expected.filter((o) => o.kind === kind).length) {
                throw new PdfRedactionError('verification_failed', `Page ${page.index + 1}: drawing changed beyond what was removed.`);
            }
        }
        const again = detectMarks(page, { terms });
        const left = [...again.marks, ...again.blocked].filter((m) => m.category !== 'logo');
        if (left.length) {
            throw new PdfRedactionError('verification_failed', `Page ${page.index + 1}: still found ${left.map((m) => `"${m.text}"`).join(', ')}.`);
        }
    }
    const raw = await rawText(outBuffer);
    const needles = [...terms.filter((t) => /^[a-z0-9]{4,}$/.test(t)), ...removedTexts.map((t) => t.toLowerCase()).filter((t) => /^[\x20-\x7e]{8,}$/.test(t))];
    const hit = needles.find((n) => raw.includes(n));
    if (hit) throw new PdfRedactionError('verification_failed', 'Identifying text is still present in the file.');
}

/**
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string[]} [opts.terms]    extra words that identify the customer (company name, brand)
 * @param {Array<{page:number,id:number,category?:string}>} [opts.aiMarks]  text runs an AI flagged
 * @returns {Promise<{ buffer: Buffer, removed: Array, summary: object, terms: string[], warnings: string[] }>}
 */
async function redactPdf(buffer, { terms: userTerms = [], aiMarks = [] } = {}) {
    const doc = await loadPdf(buffer);
    const pages = analyzeDocument(doc);
    const terms = termsFor(pages, userTerms);
    const removed = [];
    const removedIds = pages.map(() => new Set());
    const removedTexts = [];
    const summary = { pages: pages.length, text: 0, graphics: 0, images: 0, annotations: 0 };
    // A scanned page is one big picture with no text to read: nothing on it can be found, so
    // "nothing removed" must not read as "nothing there".
    const scanned = pages.filter((p) => {
        const pageArea = (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]);
        const readable = p.objects.some((o) => o.kind === 'text' && o.text.trim());
        const bigImage = p.objects.some((o) => o.kind === 'image' && (o.bbox[2] - o.bbox[0]) * (o.bbox[3] - o.bbox[1]) > pageArea * 0.5);
        return !readable && bigImage;
    }).map((p) => p.index + 1);
    const warnings = scanned.length
        ? [`Page${scanned.length > 1 ? 's' : ''} ${scanned.join(', ')} ${scanned.length > 1 ? 'are' : 'is'} a scanned image without readable text: names or logos on ${scanned.length > 1 ? 'them' : 'it'} could not be found or removed. Check ${scanned.length > 1 ? 'them' : 'it'} yourself.`]
        : [];

    for (const page of pages) {
        const ai = new Map(aiMarks.filter((m) => m.page === page.index + 1 && Number.isInteger(m.id))
            .map((m) => [m.id, ['person', 'company', 'contact', 'address'].includes(m.category) ? m.category : 'person']));
        const { marks, blocked } = detectMarks(page, { terms, aiMarks: ai });
        if (blocked.length) {
            throw new PdfRedactionError('unsupported_structure', `Page ${page.index + 1} has identifying content inside a nested drawing that cannot be cut safely.`);
        }
        if (marks.length && page.malformed) {
            throw new PdfRedactionError('unsupported_structure', `Page ${page.index + 1} has a damaged content stream.`);
        }
        summary.annotations += cleanAnnotations(doc.context, page.node, terms);
        for (const key of ['Metadata', 'PieceInfo', 'Thumb']) page.node.delete(PDFName.of(key));
        if (!marks.length) continue;

        const ranges = [];
        for (const m of marks) {
            const o = page.objects[m.id];
            ranges.push([o.start, o.end]);
            removedIds[page.index].add(o.id);
            if (o.kind === 'text') {
                summary.text++;
                removedTexts.push(o.text.trim());
                if (o.text.trim()) removed.push({ page: page.index + 1, category: m.category, text: o.text.trim() });
            } else if (o.kind === 'image') summary.images++;
            else summary.graphics++;
        }
        const stream = doc.context.flateStream(cutRanges(page.contentBytes, ranges));
        page.node.set(PDFName.of('Contents'), doc.context.register(stream));

        // An image nobody draws any more must not ride along in the file. The resources may be
        // shared with other pages, so this page gets its own copy before anything is deleted.
        const stillDrawn = new Set(page.objects.filter((o) => o.kind === 'image' && o.name && !removedIds[page.index].has(o.id)).map((o) => o.name));
        const gone = page.objects.filter((o) => o.kind === 'image' && o.name && removedIds[page.index].has(o.id) && !stillDrawn.has(o.name));
        if (gone.length && page.resources) {
            const res = page.resources.clone(doc.context);
            const xo = doc.context.lookup(res.get(PDFName.of('XObject')));
            if (xo instanceof PDFDict) {
                const copy = xo.clone(doc.context);
                for (const o of gone) copy.delete(PDFName.of(o.name));
                res.set(PDFName.of('XObject'), copy);
            }
            page.node.set(PDFName.of('Resources'), res);
        }
        const graphics = marks.filter((m) => page.objects[m.id].kind !== 'text').length;
        if (graphics) removed.push({ page: page.index + 1, category: 'logo', text: null, count: graphics });
    }

    scrubDocument(doc);
    collectGarbage(doc.context);
    const out = Buffer.from(await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }));
    await verify(out, pages, removedIds, terms, removedTexts);
    return { buffer: out, removed, summary, terms, warnings };
}

module.exports = { redactPdf, listTextRuns, PdfRedactionError, cutRanges, collectGarbage };
