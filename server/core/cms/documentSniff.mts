/**
 * Is an uploaded CMS document what its content type says? Checked on the bytes, never on the
 * name or the label the client sent (core/cms/uploadPolicy.js lists the document types).
 *
 *   PDF:                 starts with `%PDF-`.
 *   DOCX / XLSX / PPTX:  a ZIP package (starts with a local file header) whose central directory
 *                        lists `[Content_Types].xml` and the main part of that kind
 *                        (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`).
 *                        A package with a `vbaProject.bin` (macros) is refused, whatever its type.
 *
 * Only the head, the tail (end-of-central-directory record) and the central directory are read,
 * through `readAt`, so a large file is never loaded whole. Zip64 packages are refused: a CMS
 * download is far below the 4 GB where a writer needs them.
 */

/** A reader of `length` bytes at `position` (fewer at the end of the file). */
export type ReadAt = (position: number, length: number) => Promise<Buffer>;

type Kind = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export const DOCUMENT_KIND: Readonly<Record<string, Kind>> = Object.freeze({
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
});

const MAIN_PART: Readonly<Record<Exclude<Kind, 'pdf'>, string>> = {
    docx: 'word/document.xml',
    xlsx: 'xl/workbook.xml',
    pptx: 'ppt/presentation.xml',
};

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
/** A central directory larger than this is not a CMS download. */
const MAX_CD_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/** A ReadAt over a buffer already in memory. */
export function bufferReader(buf: Buffer): ReadAt {
    return async (position, length) => buf.subarray(position, Math.min(buf.length, position + length));
}

/** Where the central directory is, from the end-of-central-directory record in `tail`; null when absent or out of bounds. */
function centralDirectory(tail: Buffer, size: number): { entries: number, cdSize: number, cdOffset: number } | null {
    let at = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIG) { at = i; break; }
    }
    if (at === -1) return null;
    const entries = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    // 0xffff / 0xffffffff mark a Zip64 package.
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null;
    if (entries > MAX_ENTRIES || cdSize > MAX_CD_BYTES || cdOffset + cdSize > size) return null;
    return { entries, cdSize, cdOffset };
}

/** The entry names of a ZIP's central directory, or null when it is not a readable (non-Zip64) ZIP. */
async function zipEntryNames(size: number, readAt: ReadAt): Promise<string[] | null> {
    if (size < EOCD_MIN + 4) return null;
    const head = await readAt(0, 4);
    if (head.length < 4 || head.readUInt32LE(0) !== 0x04034b50) return null;
    const tailLen = Math.min(size, EOCD_MIN + MAX_COMMENT);
    const where = centralDirectory(await readAt(size - tailLen, tailLen), size);
    if (!where) return null;
    const { entries, cdSize, cdOffset } = where;
    const cd = await readAt(cdOffset, cdSize);
    if (cd.length !== cdSize) return null;
    const names: string[] = [];
    let p = 0;
    for (let n = 0; n < entries; n++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) return null;
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        if (p + 46 + nameLen > cd.length) return null;
        names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
}

/** Does the file of `size` bytes that `readAt` reads look like a document of `contentType`? */
export async function looksLikeDocument(contentType: string, size: number, readAt: ReadAt): Promise<boolean> {
    const kind = DOCUMENT_KIND[String(contentType || '').toLowerCase()];
    if (!kind || !(size > 0)) return false;
    if (kind === 'pdf') {
        const head = await readAt(0, 5);
        return head.length === 5 && head.toString('latin1') === '%PDF-';
    }
    const names = await zipEntryNames(size, readAt);
    if (!names) return false;
    const set = new Set(names);
    if (names.some((n) => n.toLowerCase().endsWith('vbaproject.bin'))) return false;
    return set.has('[Content_Types].xml') && set.has(MAIN_PART[kind]);
}
