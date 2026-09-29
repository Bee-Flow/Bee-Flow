/**
 * CAD metadata reader — bytes in, a short honest summary out.
 *
 * A mailed .step or .dxf is geometry, not prose: inlining the raw body into a
 * prompt burns the context window on coordinate soup and invites the model to
 * invent dimensions. This module reads ONLY the cheap, well-specified header
 * regions and emits a plain-text summary the model can quote honestly:
 *
 *   - ASCII DXF  — HEADER variables ($ACADVER, $INSUNITS, $EXTMIN/$EXTMAX)
 *                  plus an entity histogram from the ENTITIES section. The
 *                  extents give sheet width/height in mm; the circle count
 *                  approximates hole callouts, which a waterjet/laser quote
 *                  prices on.
 *   - STEP       — the HEADER; block only: FILE_NAME (first string arg —
 *                  usually the part number, the join key to the drawing and
 *                  the purchase order), FILE_DESCRIPTION, FILE_SCHEMA
 *                  (AP203/AP214/AP242).
 *   - binary DXF / DWG / IGES — identified honestly; contents not read,
 *                  and the summary says so plainly. Never guess.
 *
 * Every summary OPENS with one line stating what was and was not read, so the
 * model never presents dimensions it was not given. `extractCad` NEVER throws
 * — truncated or hostile input degrades to an "unrecognised" summary — and the
 * summary is hard-capped at 2 KB.
 */

'use strict';

// The DXF opening signature is shared with uploadGuard's byte sniff — a file
// one of them calls a DXF and the other does not is a drawing stored as an
// unreadable blob.
const { isAsciiDxfHead } = require('./cadTypes');

const SUMMARY_CAP = 2048;

// Scan caps — header regions only. A 200 MB assembly must never cost more
// than a few hundred KB of string work.
const DXF_HEADER_CAP = 256 * 1024;
const DXF_SCAN_CAP = 512 * 1024;
const STEP_HEADER_CAP = 64 * 1024;

// AC10xx → AutoCAD release. Shared by the DWG magic and the DXF $ACADVER var.
const ACAD_RELEASES = Object.freeze({
    AC1009: 'R11/R12',
    AC1012: 'R13',
    AC1014: 'R14',
    AC1015: '2000',
    AC1018: '2004',
    AC1021: '2007',
    AC1024: '2010',
    AC1027: '2013',
    AC1032: '2018+',
});

// $INSUNITS (group 70) → millimetres per drawing unit. Codes outside this map
// are reported raw and honestly, never converted on a guess.
const INSUNITS_TO_MM = Object.freeze({
    1: { label: 'inches', mm: 25.4 },
    2: { label: 'feet', mm: 304.8 },
    4: { label: 'millimetres', mm: 1 },
    5: { label: 'centimetres', mm: 10 },
    6: { label: 'metres', mm: 1000 },
});

// Entity types worth counting on group-code-0 lines of the ENTITIES section.
const COUNTED_ENTITIES = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'SPLINE', 'TEXT', 'MTEXT']);

const DXF_BINARY_SENTINEL = Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1');

// ── Format detection (bytes only — the caller already routed on name/mime) ──
function detectFormat(buf) {
    if (buf.length >= DXF_BINARY_SENTINEL.length &&
        buf.subarray(0, DXF_BINARY_SENTINEL.length).equals(DXF_BINARY_SENTINEL)) return 'dxf-binary';
    if (buf.length >= 6 && /^AC10\d\d$/.test(buf.subarray(0, 6).toString('latin1'))) return 'dwg';
    const head = buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, '');
    if (/^\s*ISO-10303-21;/.test(head)) return 'step';
    if (isAsciiDxfHead(head)) return 'dxf';
    if (looksLikeIges(buf)) return 'iges';
    return null;
}

// IGES is a fixed 80-column card format: cols 1–72 content, col 73 the section
// letter (S = Start), cols 74–80 a right-aligned sequence number. Pragmatic:
// first line 80±2 chars, an S in the col-73 zone, a trailing digit.
function looksLikeIges(buf) {
    const head = buf.subarray(0, 256).toString('latin1');
    const nl = head.indexOf('\n');
    if (nl < 0) return false;
    const line = head.slice(0, nl).replace(/\r$/, '');
    if (line.length < 78 || line.length > 82) return false;
    if (!line.slice(71, 74).includes('S')) return false;
    return /\d$/.test(line.trimEnd());
}

function round2(v) {
    return Math.round(v * 100) / 100;
}

function capSummary(text) {
    return text.length > SUMMARY_CAP ? text.slice(0, SUMMARY_CAP - 1) + '…' : text;
}

function result(text, meta) {
    return { kind: 'text', text: capSummary(text), source: 'cad', meta };
}

// ── ASCII DXF ───────────────────────────────────────────────────────
// A DXF is strictly (group-code line, value line) pairs, so we walk two lines
// at a stride. HEADER harvesting stops at its ENDSEC or the 256 KB cap,
// whichever comes first; the entity histogram runs over the ENTITIES section
// inside the overall 512 KB scan window.
function parseAsciiDxf(buf) {
    const lines = buf.subarray(0, DXF_SCAN_CAP).toString('utf8').split(/\r\n|\n/);
    const header = { acadVer: null, insunits: null, extmin: {}, extmax: {} };
    const entities = {};

    let section = null;        // current SECTION name (HEADER / ENTITIES / …)
    let pendingSection = false;
    let currentVar = null;     // header variable being read ($EXTMIN, …)
    let headerDone = false;
    let offset = 0;            // ≈ bytes consumed, for the header cap

    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = lines[i].trim();
        const value = (lines[i + 1] || '').trim();
        offset += lines[i].length + lines[i + 1].length + 4;

        if (code === '0') {
            currentVar = null;
            if (value === 'SECTION') { pendingSection = true; section = null; continue; }
            if (value === 'ENDSEC') {
                if (section === 'HEADER') headerDone = true;
                if (section === 'ENTITIES') break;
                section = null;
                continue;
            }
            if (value === 'EOF') break;
            if (section === 'ENTITIES' && COUNTED_ENTITIES.has(value)) {
                entities[value] = (entities[value] || 0) + 1;
            }
            continue;
        }
        if (pendingSection && code === '2') { section = value; pendingSection = false; continue; }
        if (section === 'HEADER' && !headerDone && offset <= DXF_HEADER_CAP) {
            if (code === '9') { currentVar = value; continue; }
            if (currentVar === '$ACADVER' && code === '1') header.acadVer = value;
            else if (currentVar === '$INSUNITS' && code === '70') header.insunits = parseInt(value, 10);
            else if (currentVar === '$EXTMIN' && code === '10') header.extmin.x = parseFloat(value);
            else if (currentVar === '$EXTMIN' && code === '20') header.extmin.y = parseFloat(value);
            else if (currentVar === '$EXTMAX' && code === '10') header.extmax.x = parseFloat(value);
            else if (currentVar === '$EXTMAX' && code === '20') header.extmax.y = parseFloat(value);
        }
    }
    return { header, entities };
}

// $EXTMIN/$EXTMAX → bounding-box width/height. Converted to mm only when
// $INSUNITS names a unit we know; otherwise reported raw, honestly.
function dxfExtents(header) {
    const { extmin, extmax, insunits } = header;
    const coords = [extmin.x, extmin.y, extmax.x, extmax.y];
    if (!coords.every(Number.isFinite)) return null;
    const w = extmax.x - extmin.x;
    const h = extmax.y - extmin.y;
    const unit = INSUNITS_TO_MM[insunits];
    if (unit) {
        return { widthMm: round2(w * unit.mm), heightMm: round2(h * unit.mm), units: unit.label, converted: true };
    }
    const units = insunits == null ? 'unspecified drawing units' : `unknown unit code ${insunits}`;
    return { width: round2(w), height: round2(h), units, converted: false };
}

function extractAsciiDxf(buf, name) {
    const { header, entities } = parseAsciiDxf(buf);
    const release = header.acadVer ? ACAD_RELEASES[header.acadVer] : null;
    const verLabel = header.acadVer
        ? `, AutoCAD ${release ? release + ' ' : ''}(${header.acadVer})`
        : '';
    const extents = dxfExtents(header);

    const lines = [
        `CAD drawing "${name}" (ASCII DXF${verLabel}). Only the HEADER variables and entity counts below were read — the geometry itself was not interpreted; do not state any dimension not listed here.`,
    ];
    if (extents && extents.converted) {
        lines.push(`Extents (bounding box): ${extents.widthMm} mm × ${extents.heightMm} mm (converted from ${extents.units}).`);
    } else if (extents) {
        lines.push(`Extents (bounding box): ${extents.width} × ${extents.height} in ${extents.units} — NOT converted to mm.`);
    } else {
        lines.push('Extents: not present in the header.');
    }
    const counted = Object.entries(entities).sort((a, b) => b[1] - a[1]);
    if (counted.length) {
        const list = counted.map(([k, n]) => `${k} ×${n}`).join(', ');
        lines.push(`Entities: ${list}. (Circle count approximates hole callouts.)`);
    } else {
        lines.push('Entities: none counted in the scanned region.');
    }

    return result(lines.join('\n'), {
        format: 'dxf',
        bytes: buf.length,
        acadVer: header.acadVer,
        release,
        insunits: header.insunits,
        extents,
        entities,
    });
}

// ── STEP (ISO 10303-21) ─────────────────────────────────────────────
function parseStepHeader(buf) {
    const text = buf.subarray(0, STEP_HEADER_CAP).toString('utf8');
    const start = text.indexOf('HEADER;');
    const end = text.indexOf('ENDSEC;');
    const head = start >= 0 ? text.slice(start, end > start ? end : undefined) : text;
    // Part-21 strings are 'quoted' with '' as the escape for a literal quote.
    const first = (re) => {
        const m = re.exec(head);
        return m ? m[1].replace(/''/g, "'") : null;
    };
    return {
        fileName: first(/FILE_NAME\s*\(\s*'((?:[^']|'')*)'/),
        description: first(/FILE_DESCRIPTION\s*\(\s*\(\s*'((?:[^']|'')*)'/),
        schema: first(/FILE_SCHEMA\s*\(\s*\(\s*'((?:[^']|'')*)'/),
    };
}

function stepApFromSchema(schema) {
    if (!schema) return null;
    const s = schema.toUpperCase();
    if (/AP242|MANAGED_MODEL_BASED|10303\s+442/.test(s)) return 'AP242';
    if (/AP214|AUTOMOTIVE_DESIGN|10303\s+214/.test(s)) return 'AP214';
    if (/AP203|CONFIG(URATION)?_CONTROL_DESIGN|10303\s+203/.test(s)) return 'AP203';
    return null;
}

function extractStep(buf, name) {
    const { fileName, description, schema } = parseStepHeader(buf);
    const ap = stepApFromSchema(schema);

    const lines = [
        `CAD model "${name}" (STEP${ap ? ' ' + ap : ''}). Only the file HEADER was read — no geometry, dimensions or part counts are known from this summary.`,
    ];
    if (fileName) {
        lines.push(`Header file name: "${fileName}" (usually the part number — the join key to the drawing and the purchase order).`);
    }
    if (description) lines.push(`Description: ${description}`);
    if (schema) lines.push(`Schema: ${schema}${ap ? ` (${ap})` : ''}.`);
    if (!fileName && !description && !schema) {
        lines.push('The HEADER block was missing or unreadable — nothing else is known.');
    }

    return result(lines.join('\n'), {
        format: 'step',
        bytes: buf.length,
        fileName,
        description,
        schema,
        ap,
    });
}

// ── Binary formats: identify, never guess ───────────────────────────
function extractBinaryDxf(buf, name) {
    return result(
        `"${name}" is a BINARY DXF file (${buf.length} bytes). The binary header was not read — no version, units, extents or entity counts are available. Do not infer anything about the drawing's contents.`,
        { format: 'dxf-binary', bytes: buf.length },
    );
}

function extractDwg(buf, name) {
    const magic = buf.subarray(0, 6).toString('latin1');
    const release = ACAD_RELEASES[magic] || null;
    const verLabel = release ? `AutoCAD ${release} (${magic})` : `unknown version (${magic})`;
    return result(
        `"${name}" is an AutoCAD DWG file, ${verLabel}, ${buf.length} bytes. DWG is a closed binary format — the geometry was not read; no dimensions or contents are known.`,
        { format: 'dwg', bytes: buf.length, dwgVersion: magic, release },
    );
}

function extractIges(buf, name) {
    return result(
        `"${name}" is an IGES file (${buf.length} bytes). Identified by its fixed 80-column format only — the contents were not read; no dimensions are known.`,
        { format: 'iges', bytes: buf.length },
    );
}

// ── Public API ──────────────────────────────────────────────────────
/**
 * @param {Buffer} buffer   the attachment bytes
 * @param {string} filename shown in the summary so the model can cite it
 * @returns {{ kind: 'text', text: string, source: 'cad', meta: object }}
 *          NEVER throws — hostile/truncated input degrades to honesty.
 */
function extractCad(buffer, filename) {
    const name = String(filename || 'attachment');
    try {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
        switch (detectFormat(buf)) {
            case 'dxf': return extractAsciiDxf(buf, name);
            case 'dxf-binary': return extractBinaryDxf(buf, name);
            case 'step': return extractStep(buf, name);
            case 'dwg': return extractDwg(buf, name);
            case 'iges': return extractIges(buf, name);
            default:
                return result(
                    `"${name}" was flagged as CAD by its name/type but the bytes match no known CAD signature (${buf.length} bytes). Nothing was read; nothing is known about its contents.`,
                    { format: 'unknown', bytes: buf.length },
                );
        }
    } catch (err) {
        return result(
            `CAD file "${name}": metadata could not be read (${err.message}). Nothing is known about its contents.`,
            { format: 'unknown', error: err.message },
        );
    }
}

module.exports = {
    extractCad,
    // Shared with dxfRender: what a drawing unit is worth in millimetres is
    // one fact, and a preview caption that disagreed with the AI's summary
    // about the size of the same plate would be worse than no caption.
    INSUNITS_TO_MM,
    // exposed for tests
    detectFormat,
    parseAsciiDxf,
    parseStepHeader,
    stepApFromSchema,
    SUMMARY_CAP,
};
