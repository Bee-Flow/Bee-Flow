// @typecheck
/**
 * PPTX extractor — the text of a presentation, slide by slide, notes included.
 *
 * A .pptx is a ZIP of XML parts: one `ppt/slides/slideN.xml` per slide, each
 * with an optional `ppt/notesSlides/notesSlideK.xml` reached through the
 * slide's `_rels`. There is no library for this in the dependency set and
 * none is needed: the text runs are `<a:t>` elements grouped in `<a:p>`
 * paragraphs, which a regex reads more predictably than a DOM walk over
 * DrawingML's dozen namespaces.
 *
 * Two choices worth stating:
 *
 *  - Slides are ordered NUMERICALLY by their part name. A lexical sort puts
 *    slide10 before slide2; a deck read in that order summarises wrong.
 *    (`presentation.xml`'s sldIdLst is the authoritative order, but the part
 *    numbers follow it in every writer we have met, and reading the list
 *    adds a second rels hop for no observed gain.)
 *  - Every slide becomes a `## Slide N: <title>` section and the notes a
 *    labelled block under it, so a model asked to "summarise per slide" has
 *    the boundaries it needs and never quotes a speaker note as slide text.
 *
 * Zip-bomb guard: each part's uncompressed size is checked BEFORE it is
 * inflated. A 20 KB .pptx that claims a 2 GB slide XML is refused, not read.
 */

const JSZip = require('jszip');

const DEFAULTS = Object.freeze({
    maxSlides: 500,
    maxPartBytes: 20 * 1024 * 1024,
});

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function decodeXml(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
}

/** The text of one paragraph: its runs joined, line breaks honoured. */
function paragraphText(pXml) {
    const parts = [];
    const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>|<a:tab\s*\/>/g;
    let m;
    while ((m = re.exec(pXml))) {
        if (m[0].startsWith('<a:br')) parts.push('\n');
        else if (m[0].startsWith('<a:tab')) parts.push('\t');
        else parts.push(decodeXml(m[1]));
    }
    return parts.join('').replace(/[ \t]+\n/g, '\n').trim();
}

/** The `type` of a shape's placeholder (`title`, `ctrTitle`, `sldNum`, …) or null. */
function placeholderType(spXml) {
    const m = /<p:ph\b([^>]*)\/?>/.exec(spXml);
    if (!m) return null;
    const t = /\btype="([^"]+)"/.exec(m[1]);
    return t ? t[1] : 'body';
}

const SKIP_PLACEHOLDERS = new Set(['sldNum', 'ftr', 'dt']);

/**
 * Walk the shapes of a slide (or notes) part: `{ title, paragraphs }`.
 * Tables (`<a:tbl>`) become `| a | b |` lines; grouped shapes are read
 * through, since their text runs sit in the same markup.
 */
function readSlidePart(xml, { titleFrom = ['title', 'ctrTitle'] } = {}) {
    let title = '';
    const paragraphs = [];

    // Tables first, so their cells are not also read as loose paragraphs.
    const tables = [];
    const withoutTables = xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, (tbl) => {
        const rows = [];
        const rowRe = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g;
        let r;
        while ((r = rowRe.exec(tbl))) {
            const cells = [];
            const cellRe = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g;
            let c;
            while ((c = cellRe.exec(r[1]))) {
                const ps = [];
                const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
                let p;
                while ((p = pRe.exec(c[1]))) { const t = paragraphText(p[1]); if (t) ps.push(t); }
                cells.push(ps.join(' '));
            }
            if (cells.length) rows.push(`| ${cells.join(' | ')} |`);
        }
        if (rows.length) tables.push(rows.join('\n'));
        return '';
    });

    const spRe = /<p:sp\b[\s\S]*?<\/p:sp>/g;
    let sp;
    while ((sp = spRe.exec(withoutTables))) {
        const ph = placeholderType(sp[0]);
        if (ph && SKIP_PLACEHOLDERS.has(ph)) continue;
        const ps = [];
        const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
        let p;
        while ((p = pRe.exec(sp[0]))) { const t = paragraphText(p[1]); if (t) ps.push(t); }
        if (!ps.length) continue;
        if (!title && ph && titleFrom.includes(ph)) { title = ps.shift(); }
        paragraphs.push(...ps);
    }
    if (!title && paragraphs.length && titleFrom.length) title = paragraphs.shift();
    for (const t of tables) paragraphs.push(t);
    return { title, paragraphs };
}

async function readPart(zip, name, maxPartBytes) {
    const entry = zip.file(name);
    if (!entry) return null;
    const size = entry._data && typeof entry._data.uncompressedSize === 'number' ? entry._data.uncompressedSize : 0;
    if (size > maxPartBytes) {
        throw Object.assign(new Error(`${name} is ${Math.round(size / 1048576)} MB uncompressed; the limit is ${Math.round(maxPartBytes / 1048576)} MB.`), { errorClass: 'pptx_part_too_large' });
    }
    return entry.async('string');
}

/** The notes part a slide links to, via its rels, or null. */
async function notesPartFor(zip, slideName, maxPartBytes) {
    const base = slideName.split('/').pop();
    const rels = await readPart(zip, `ppt/slides/_rels/${base}.rels`, maxPartBytes);
    if (!rels) return null;
    const m = /<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"/.exec(rels)
        || /<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/notesSlide"/.exec(rels);
    if (!m) return null;
    const target = m[1].replace(/^\.\.\//, 'ppt/').replace(/^\/+/, '');
    return target.startsWith('ppt/') ? target : `ppt/slides/${target}`;
}

/** True for a ZIP that carries a presentation part. */
async function isPptxBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
    try {
        const zip = await JSZip.loadAsync(buffer);
        return !!zip.file('ppt/presentation.xml');
    } catch { return false; }
}

/**
 * @param {Buffer} buffer
 * @param {{ maxSlides?: number, maxPartBytes?: number }} [opts]
 * @returns {Promise<{ text: string, slideCount: number, notesCount: number }>}
 */
async function extractPptxText(buffer, opts = {}) {
    const { maxSlides, maxPartBytes } = { ...DEFAULTS, ...opts };
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
        .map((n) => ({ n, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(n) }))
        .filter((x) => x.m)
        .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
        .map((x) => x.n);

    const sections = [];
    let notesCount = 0;
    const total = slideNames.length;
    for (const [i, name] of slideNames.slice(0, maxSlides).entries()) {
        const xml = await readPart(zip, name, maxPartBytes);
        const { title, paragraphs } = readSlidePart(xml || '');
        const lines = [`## Slide ${i + 1}${title ? `: ${title}` : ''}`];
        if (paragraphs.length) lines.push(paragraphs.join('\n'));

        const notesName = await notesPartFor(zip, name, maxPartBytes);
        if (notesName) {
            const notesXml = await readPart(zip, notesName, maxPartBytes);
            if (notesXml) {
                const notes = readSlidePart(notesXml, { titleFrom: [] });
                if (notes.paragraphs.length) {
                    notesCount += 1;
                    lines.push('', 'Speaker notes:', notes.paragraphs.join('\n'));
                }
            }
        }
        sections.push(lines.join('\n'));
    }
    if (total > maxSlides) sections.push(`_(${total - maxSlides} more slides not read — the limit is ${maxSlides}.)_`);
    return { text: sections.join('\n\n').trim(), slideCount: total, notesCount };
}

module.exports = { extractPptxText, isPptxBuffer, PPTX_MIME, DEFAULTS, _test: { readSlidePart, paragraphText, decodeXml } };
