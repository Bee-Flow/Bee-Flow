/**
 * core/datasets — VCF text parsing. Pure functions, no I/O.
 *
 * Two consumers with different needs share this module so their reading of a
 * line can never disagree:
 *   - ingest.js  validates every data line once, at ingest time (strict:
 *     malformed input fails the ingest with a line number, never later).
 *   - query.js   re-parses only the lines inside a queried region (fast path:
 *     the line was already validated at ingest, so it trusts the shape).
 *
 * Genotypes are parsed LAZILY (parseGenotypes) — a WGS line with hundreds of
 * samples is mostly genotype columns, and most queries do not ask for them.
 */

// Fixed VCF columns. Everything after FORMAT is one column per sample.
const FIXED_COLS = ['CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO'];

// chr1's length is a fingerprint of the reference build — it differs between
// the two human assemblies and appears in every well-formed ##contig header.
const CHR1_LENGTH_TO_BUILD = {
    248956422: 'GRCh38',
    249250621: 'GRCh37',
};

/** Parse one ##key=<A=1,B="x,y"> structured meta line's angle-bracket body. */
function parseStructuredMeta(body) {
    const out = {};
    // Split on commas that are not inside double quotes.
    let field = '';
    let inQuotes = false;
    const fields = [];
    for (const ch of body) {
        if (ch === '"') inQuotes = !inQuotes;
        if (ch === ',' && !inQuotes) { fields.push(field); field = ''; }
        else field += ch;
    }
    if (field) fields.push(field);
    for (const f of fields) {
        const eq = f.indexOf('=');
        if (eq === -1) continue;
        const k = f.slice(0, eq).trim();
        let v = f.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        if (k) out[k] = v;
    }
    return out;
}

/**
 * Parse the complete header (every ## line plus the #CHROM line).
 * @param {string} headerText
 * @returns {{ contigs: Array<{id:string,length:number|null}>, samples: string[],
 *             build: 'GRCh37'|'GRCh38'|null, infoKeys: string[], headerText: string }}
 */
function parseHeader(headerText) {
    const lines = String(headerText || '').split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0 || !lines[0].startsWith('##fileformat=VCF')) {
        throw new Error('not a VCF: the first line must be ##fileformat=VCFv…');
    }
    const contigs = [];
    const infoKeys = [];
    let referenceLine = null;
    let samples = [];
    let sawColumnLine = false;

    for (const line of lines) {
        if (line.startsWith('##contig=<') && line.endsWith('>')) {
            const meta = parseStructuredMeta(line.slice('##contig=<'.length, -1));
            if (meta.ID) {
                const length = Number.parseInt(meta.length, 10);
                contigs.push({ id: meta.ID, length: Number.isFinite(length) ? length : null });
            }
        } else if (line.startsWith('##INFO=<') && line.endsWith('>')) {
            const meta = parseStructuredMeta(line.slice('##INFO=<'.length, -1));
            if (meta.ID) infoKeys.push(meta.ID);
        } else if (line.startsWith('##reference=')) {
            referenceLine = line.slice('##reference='.length);
        } else if (line.startsWith('#CHROM')) {
            sawColumnLine = true;
            const cols = line.slice(1).split('\t');
            for (let i = 0; i < FIXED_COLS.length; i++) {
                if (cols[i] !== FIXED_COLS[i]) {
                    throw new Error(`malformed #CHROM line: expected column ${FIXED_COLS[i]}, got ${cols[i] ?? '(missing)'}`);
                }
            }
            // Column 8 is FORMAT — present only when there are samples.
            samples = cols.length > 9 ? cols.slice(9) : [];
        }
    }
    if (!sawColumnLine) throw new Error('not a VCF: missing the #CHROM column line');

    // Build inference is DETERMINISTIC, never a guess: an explicit ##reference
    // naming the build wins; otherwise chr1's declared length; otherwise null
    // (the manifest stores null and gene-name queries are refused with a clear
    // message — silently assuming a build would return wrong coordinates).
    let build = null;
    if (referenceLine) {
        if (/grch38|hg38/i.test(referenceLine)) build = 'GRCh38';
        else if (/grch37|hg19|b37/i.test(referenceLine)) build = 'GRCh37';
    }
    if (!build) {
        const chr1 = contigs.find((c) => c.id === 'chr1' || c.id === '1');
        if (chr1 && CHR1_LENGTH_TO_BUILD[chr1.length]) build = CHR1_LENGTH_TO_BUILD[chr1.length];
    }

    return { contigs, samples, build, infoKeys, headerText: lines.join('\n') };
}

/**
 * Parse the first 8 (fixed) columns of one data line. Strict: used by ingest
 * to validate, so failures carry precise reasons.
 * @returns {{ chrom, pos, id, ref, alt, qual, filter, info, cols }} — `cols` is
 *   the raw split, retained so parseGenotypes need not re-split.
 */
function parseDataLine(line) {
    const cols = line.split('\t');
    if (cols.length < 8) {
        throw new Error(`data line has ${cols.length} columns (VCF requires at least 8)`);
    }
    const pos = Number.parseInt(cols[1], 10);
    if (!Number.isFinite(pos) || pos < 0 || String(pos) !== cols[1].trim()) {
        throw new Error(`POS is not a non-negative integer: "${cols[1]}"`);
    }
    if (!cols[0]) throw new Error('CHROM is empty');
    return {
        chrom: cols[0],
        pos,
        id: cols[2],
        ref: cols[3],
        alt: cols[4],
        qual: cols[5] === '.' ? null : Number.parseFloat(cols[5]),
        filter: cols[6],
        info: cols[7],
        cols,
    };
}

/**
 * Genotype columns for one already-parsed line. Lazy by design — see header.
 * @returns {Array<{sample:string, value:string}>} raw per-sample strings plus
 *   the FORMAT key, or [] when the file carries no samples.
 */
function parseGenotypes(parsedLine, samples) {
    const { cols } = parsedLine;
    if (!Array.isArray(samples) || samples.length === 0 || cols.length < 10) return { format: null, samples: [] };
    return {
        format: cols[8],
        samples: samples.map((name, i) => ({ sample: name, value: cols[9 + i] ?? '.' })),
    };
}

/**
 * Project selected keys out of an INFO string ("AF=0.01;DP=30;DB").
 * Flag keys (present without a value) come back as true.
 * @param {string} infoStr
 * @param {string[]|null} keys — null = all keys.
 */
function parseInfoFields(infoStr, keys = null) {
    const out = {};
    if (!infoStr || infoStr === '.') return out;
    const want = keys ? new Set(keys) : null;
    for (const part of infoStr.split(';')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const k = eq === -1 ? part : part.slice(0, eq);
        if (want && !want.has(k)) continue;
        out[k] = eq === -1 ? true : part.slice(eq + 1);
    }
    return out;
}

/** rs-number of an ID column value, or null ("rs548049170" → 548049170). */
function rsNumberOf(id) {
    const m = /^rs(\d+)$/.exec(id || '');
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isSafeInteger(n) ? n : null;
}

module.exports = { parseHeader, parseDataLine, parseGenotypes, parseInfoFields, rsNumberOf, CHR1_LENGTH_TO_BUILD };
