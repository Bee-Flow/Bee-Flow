// @typecheck
/**
 * The pdfkit conventions this codebase already had, in one place.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `utils/compliancePdf.js` had grown a small, good set of private helpers — a
 * document factory with named margins and `bufferPages`, a chunk collector, a
 * table that measures its own rows and repeats its header across a page break,
 * a footer that writes itself onto every page afterwards. Everything about them
 * was right except that they were private, so the next pdfkit document in the
 * repo (a demo-data generator) re-implemented the easy
 * one, skipped the hard ones, and got both wrong: its table ran off the bottom
 * of the page with no break, and its footer overflowed the bottom margin by
 * 0.09 pt and silently produced a blank second page on every drawing.
 *
 * That is the whole argument for lifting them. A duplicated helper is not a
 * duplicated helper for long; it is two helpers that disagree.
 *
 * THE FOOTER RULE, SPECIFICALLY
 * -----------------------------
 * pdfkit breaks to a new page when `y + lineHeight > maxY`, and Helvetica at
 * 7 pt has a line height of 8.09 pt. A footer positioned by eye ("near the
 * bottom") is therefore a coin toss decided in hundredths of a point. `footer()`
 * takes that decision away: it runs after the content is finished, over
 * `bufferedPageRange()`, and writes with `lineBreak: false` so the text can
 * physically not ask for a page that does not exist.
 */

'use strict';

const PDFDocument = require('pdfkit');

// The platform's document palette (slate). Shared so two generated documents
// cannot drift into two different greys.
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';

/**
 * A document with named margins and `bufferPages`.
 *
 * `bufferPages` is not an optimisation — it is what makes a per-page footer
 * possible at all, because pages stay addressable until `doc.end()`.
 *
 * @param {{ landscape?: boolean, margins?: object, size?: string, info?: object }} [options]
 */
function newDoc({ landscape = false, margins, size = 'A4', info } = {}) {
    const doc = new PDFDocument({
        size,
        layout: landscape ? 'landscape' : 'portrait',
        margins: margins || { top: 56, bottom: 64, left: 56, right: 56 },
        bufferPages: true,
    });
    // A generated document that names itself is one a reader can file. Nothing
    // here is a claim about provenance beyond what the caller passes.
    if (info) Object.assign(doc.info, info);
    return doc;
}

/** The finished bytes. Resolves on 'end', so call `doc.end()` (or `finish()`). */
function collect(doc) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
}

/**
 * A column table that measures its own rows and repeats its header.
 *
 * columns: [{ label, width, key, bold?, align?, color?: (row) => hex }]
 * Cell text is `row[key]`, already stringified by the caller.
 */
function table(doc, { columns, rows, fontSize = 8, zebra = false }) {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    const drawHeader = () => {
        let x = left;
        doc.fontSize(fontSize).font('Helvetica-Bold').fillColor(MUTED);
        const headerY = doc.y;
        for (const c of columns) {
            doc.text(String(c.label).toUpperCase(), x, headerY, { width: c.width, align: c.align || 'left', lineBreak: false });
            x += c.width + 8;
        }
        doc.y = headerY + fontSize + 4;
        doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(LINE).lineWidth(0.5).stroke();
        doc.y += 4;
    };

    drawHeader();
    for (const [i, row] of rows.entries()) {
        doc.fontSize(fontSize).font('Helvetica');
        const heights = columns.map((c) => doc.heightOfString(String(row[c.key] ?? '—'), { width: c.width }));
        const rowH = Math.max(...heights, fontSize + 2) + 5;
        if (doc.y + rowH > doc.page.height - doc.page.margins.bottom - 20) {
            doc.addPage();
            drawHeader();
        }
        const y = doc.y;
        if (zebra && i % 2 === 1) {
            doc.rect(left - 2, y - 2, right - left + 4, rowH).fill('#f8fafc');
        }
        let x = left;
        for (const c of columns) {
            const color = typeof c.color === 'function' ? (c.color(row) || INK) : INK;
            doc.fontSize(fontSize).font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color)
                .text(String(row[c.key] ?? '—'), x, y, { width: c.width, align: c.align || 'left' });
            x += c.width + 8;
        }
        doc.y = y + rowH;
    }
    doc.x = left;
}

/**
 * Write `text` onto every page and end the document.
 *
 * This is the ONLY correct place for a footer. Drawn inline while content is
 * flowing, it competes with the content for the bottom margin and wins or loses
 * by fractions of a point; drawn here it cannot, because every page already
 * exists and `lineBreak: false` forbids asking for another.
 */
function footer(doc, text, { pageNumbers = true, fontSize = 7.5 } = {}) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        const y = doc.page.height - 46;

        // A footer belongs IN the bottom margin, and pdfkit will not write
        // there: LineWrapper breaks to a new page whenever `y > maxY`, before
        // it draws anything, and `lineBreak: false` does not suppress that —
        // it only stops wrapping WITHIN a line. So the margin is stood down for
        // the width of this one call and put straight back.
        //
        // This is the bug, exactly. The version of this loop that lived in
        // compliancePdf.js wrote at the same `height - 46` against a 64 pt
        // bottom margin, so EVERY auditor-facing PDF this product has ever
        // produced ended with a blank page — invisible in review, because a
        // reviewer reads the content and stops.
        const keep = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        try {
            const width = doc.page.width - doc.page.margins.left - doc.page.margins.right - (pageNumbers ? 60 : 0);
            if (text) {
                doc.fontSize(fontSize).font('Helvetica').fillColor(MUTED)
                    .text(text, doc.page.margins.left, y, { width, lineBreak: false });
            }
            if (pageNumbers && range.count > 1) {
                doc.fontSize(fontSize).font('Helvetica').fillColor(MUTED)
                    .text(`${i - range.start + 1} / ${range.count}`,
                        doc.page.width - doc.page.margins.right - 40, y, { width: 40, align: 'right', lineBreak: false });
            }
        } finally {
            doc.page.margins.bottom = keep;
        }
    }
    doc.end();
}

module.exports = { PDFDocument, INK, MUTED, LINE, newDoc, collect, table, footer };
