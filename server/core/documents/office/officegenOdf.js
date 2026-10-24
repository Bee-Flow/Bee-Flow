const JSZip = require('jszip');
const { xmlEscape, isNumericCell, sanitizeSheetName } = require('./xlsxWorkbook');

// ── MIME types (match Nextcloud's mimetypemapping.json) ─────────────────
const CONTENT_TYPES = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text',
    csv: 'text/csv',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ── ODS (ODF spreadsheet) ───────────────────────────────────────────────
function odsCell(val) {
    if (val === null || val === undefined || val === '') return '<table:table-cell/>';
    if (isNumericCell(val)) {
        return `<table:table-cell office:value-type="float" office:value="${val}"><text:p>${xmlEscape(val)}</text:p></table:table-cell>`;
    }
    return `<table:table-cell office:value-type="string"><text:p>${xmlEscape(val)}</text:p></table:table-cell>`;
}

async function buildOds(matrix, sheetName) {
    const name = sanitizeSheetName(sheetName);
    const rows = matrix.map((row) => `<table:table-row>${row.map(odsCell).join('')}</table:table-row>`).join('');
    const content =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">' +
        '<office:body><office:spreadsheet>' +
        `<table:table table:name="${xmlEscape(name)}">${rows}</table:table>` +
        '</office:spreadsheet></office:body></office:document-content>';
    return packOdf(CONTENT_TYPES.ods, content);
}

// ── ODT (ODF text) ──────────────────────────────────────────────────────
async function buildOdt(content, title) {
    const blocks = parseBlocks(content);
    const body = [];
    if (title && String(title).trim()) body.push(`<text:h text:outline-level="1">${xmlEscape(String(title).trim())}</text:h>`);
    for (const b of blocks) {
        if (b.type === 'blank') body.push('<text:p/>');
        else if (b.type === 'heading') body.push(`<text:h text:outline-level="${b.level}">${xmlEscape(b.text)}</text:h>`);
        else if (b.type === 'bullet') body.push(`<text:p>• ${xmlEscape(b.text)}</text:p>`);
        else body.push(`<text:p>${xmlEscape(b.text)}</text:p>`);
    }
    const contentXml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">' +
        `<office:body><office:text>${body.join('')}</office:text></office:body></office:document-content>`;
    return packOdf(CONTENT_TYPES.odt, contentXml);
}

/**
 * Pack an ODF document. ODF requires the `mimetype` entry FIRST and STORED
 * (uncompressed) so the type can be sniffed from a fixed offset.
 */
async function packOdf(mimetype, contentXml) {
    const zip = new JSZip();
    zip.file('mimetype', mimetype, { compression: 'STORE' });
    zip.file('META-INF/manifest.xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
        `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>` +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
        '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
        '</manifest:manifest>');
    zip.file('content.xml', contentXml);
    // An (empty) styles.xml is part of every real ODF package, and SheetJS
    // refuses to READ an .ods without one. Without it the ledger this tool
    // created on run 1 could not be appended to on run 2
    // (nextcloud_create_spreadsheet ifExists:"append").
    zip.file('styles.xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Parse plain text / light Markdown into blocks for docx/odt rendering. */
function parseBlocks(content) {
    const lines = String(content == null ? '' : content).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { blocks.push({ type: 'blank' }); continue; }
        let m;
        if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { blocks.push({ type: 'heading', level: m[1].length, text: stripInline(m[2]) }); continue; }
        if ((m = /^[-*]\s+(.*)$/.exec(line))) { blocks.push({ type: 'bullet', text: stripInline(m[1]) }); continue; }
        blocks.push({ type: 'para', text: stripInline(line) });
    }
    return blocks;
}

/** Strip light Markdown emphasis markers so they don't render literally. */
function stripInline(text) {
    return String(text)
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(?<!\*)\*(?!\*)(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1');
}

module.exports = { CONTENT_TYPES, buildOds, buildOdt, parseBlocks };
