// @typecheck
/**
 * HTTP Range header parsing (RFC 7233), for media routes.
 *
 * Pulled out of the transcriptions audio route because the same logic is needed
 * for BOTH the local-file branch and the object-storage branch. It only existed
 * for the local one, which is why a recording served from RustFS could not be
 * seeked — and why iOS Safari, which will not begin playback of a media resource
 * that does not advertise ranges, refused to play those notes at all.
 */

'use strict';

/**
 * @param {string|undefined} header  The raw `Range` header.
 * @param {number} totalSize         Size of the full resource in bytes.
 * @returns {null | {start: number, end: number} | {invalid: true}}
 *   - `null`            no (or empty) Range header → serve the whole resource, 200
 *   - `{start, end}`    inclusive byte range → 206
 *   - `{invalid: true}` unsatisfiable or malformed → 416
 */
function parseRangeHeader(header, totalSize) {
    if (!header) return null;
    const size = Number(totalSize);
    if (!Number.isFinite(size) || size <= 0) return { invalid: true };

    const raw = String(header).trim();
    const m = /^bytes=(.*)$/i.exec(raw);
    if (!m) return { invalid: true };

    // Multi-range ("bytes=0-1,5-6") needs a multipart/byteranges body. Serving
    // just the first part would silently hand back the wrong bytes, so refuse.
    if (m[1].includes(',')) return { invalid: true };

    const spec = /^(\d*)-(\d*)$/.exec(m[1].trim());
    if (!spec) return { invalid: true };
    const [, startStr, endStr] = spec;
    if (startStr === '' && endStr === '') return { invalid: true };

    let start;
    let end;
    if (startStr === '') {
        // Suffix form: "bytes=-500" means the LAST 500 bytes, not "up to 500".
        const suffix = Number(endStr);
        if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(startStr);
        // Open end: "bytes=0-" means "from here to the end".
        end = endStr === '' ? size - 1 : Number(endStr);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
        // A client may ask past the end; clamp rather than 416, which is what
        // browsers expect while they are probing an unknown-length stream.
        if (end > size - 1) end = size - 1;
    }

    if (start > end || start < 0 || start > size - 1) return { invalid: true };
    return { start, end };
}

module.exports = { parseRangeHeader };
