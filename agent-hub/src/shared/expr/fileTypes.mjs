/**
 * File types for rules — "File type is PDF" instead of a MIME substring,
 * which is wrong for .pptx/.xlsx and for Gmail's application/octet-stream.
 *
 * One table (MIME exact, MIME prefixes, extensions, the words a person uses)
 * read by the `fileType()` function, by both platforms' rule rows and by
 * Suggest outputs, so the three can never disagree about what a PDF is.
 * Re-exported by rules.mjs; pure, dependency-free, string methods only.
 */

/** For rules.mjs too. */
export const isDigit = (c) => c >= '0' && c <= '9';

/** A record (not a list, a date or a class instance). For rules.mjs too. */
export function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** Append `[*]` (path.mjs appendWildcard, inlined: this file has no imports). */
const appendWildcard = (prefix) => `${prefix || ''}[*]`;

export const FILE_TYPE_KEYS = Object.freeze(['pdf', 'word', 'excel', 'powerpoint', 'image', 'text', 'archive', 'audio', 'video', 'other']);

const FILE_TYPES = [
    { key: 'pdf', exact: ['application/pdf', 'application/x-pdf'], prefixes: [], ext: ['pdf'], words: ['pdf', 'pdfs'] },
    {
        key: 'word',
        exact: ['application/msword', 'application/rtf', 'text/rtf', 'application/vnd.oasis.opendocument.text'],
        prefixes: ['application/vnd.openxmlformats-officedocument.wordprocessingml', 'application/vnd.ms-word'],
        ext: ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'rtf'],
        words: ['word', 'doc', 'docx', 'msword'],
    },
    {
        key: 'excel',
        exact: ['application/vnd.ms-excel', 'text/csv', 'application/csv', 'application/vnd.oasis.opendocument.spreadsheet'],
        prefixes: ['application/vnd.openxmlformats-officedocument.spreadsheetml', 'application/vnd.ms-excel'],
        ext: ['xls', 'xlsx', 'xlsm', 'ods', 'csv'],
        words: ['excel', 'xls', 'xlsx', 'spreadsheet', 'spreadsheets', 'csv'],
    },
    {
        key: 'powerpoint',
        exact: ['application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.presentation'],
        prefixes: ['application/vnd.openxmlformats-officedocument.presentationml', 'application/vnd.ms-powerpoint'],
        ext: ['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key'],
        words: ['powerpoint', 'ppt', 'pptx', 'presentation', 'presentations', 'slides'],
    },
    {
        key: 'image', exact: [], prefixes: ['image/'],
        ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg'],
        words: ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'jpg', 'jpeg', 'png'],
    },
    { key: 'text', exact: ['application/json', 'application/xml'], prefixes: ['text/'], ext: ['txt', 'md', 'log', 'json', 'xml', 'html', 'htm'], words: ['txt'] },
    {
        key: 'archive',
        exact: ['application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed', 'application/x-rar-compressed',
            'application/vnd.rar', 'application/gzip', 'application/x-gzip', 'application/x-tar'],
        prefixes: [], ext: ['zip', '7z', 'rar', 'gz', 'tgz', 'tar'], words: ['zip', 'archive', 'archives'],
    },
    { key: 'audio', exact: [], prefixes: ['audio/'], ext: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'], words: ['audio', 'mp3', 'recording', 'recordings'] },
    { key: 'video', exact: [], prefixes: ['video/'], ext: ['mp4', 'mov', 'mkv', 'avi', 'webm'], words: ['video', 'videos', 'mp4'] },
];

const GENERIC_MIME = new Set(['application/octet-stream', 'binary/octet-stream', 'application/x-download',
    'application/download', 'application/force-download', 'application/unknown', '']);
const TYPE_BY_EXACT = new Map(FILE_TYPES.flatMap((t) => t.exact.map((m) => [m, t.key])));
const TYPE_BY_EXT = new Map(FILE_TYPES.flatMap((t) => t.ext.map((e) => [e, t.key])));
const MIME_KEYS = ['mimeType', 'mime_type', 'mimetype', 'contentType', 'content_type', 'mediaType'];
const NAME_KEYS = ['filename', 'fileName', 'file_name', 'name', 'originalName', 'title', 'path'];
// What a MIME type may hold besides letters and digits (RFC 6838 restricted names).
const MIME_PUNCT = new Set(['!', '#', '$', '&', '^', '_', '.', '+', '-']);

const mimeOf = (text) => text.split(';')[0].trim().toLowerCase();

/** `type/subtype` (parameters after `;` allowed), nothing else. */
function looksLikeMime(text) {
    const m = mimeOf(text);
    const slash = m.indexOf('/');
    if (slash <= 0 || slash === m.length - 1 || m.indexOf('/', slash + 1) >= 0) return false;
    for (const c of m) {
        if (c === '/' || MIME_PUNCT.has(c) || isDigit(c) || (c >= 'a' && c <= 'z')) continue;
        return false;
    }
    return true;
}

/** The type a MIME names; null for an unknown or a generic one (octet-stream). */
function typeByMime(text) {
    const m = mimeOf(text);
    if (GENERIC_MIME.has(m)) return null;
    const exact = TYPE_BY_EXACT.get(m);
    if (exact) return exact;
    const hit = FILE_TYPES.find((t) => t.prefixes.some((p) => m.startsWith(p)));
    return hit ? hit.key : null;
}

/** The type a file name's extension names (`a.PPTX` → powerpoint); null when none is known. */
function typeByExtension(name) {
    const base = name.trim();
    const dot = base.lastIndexOf('.');
    if (dot < 0 || dot < base.lastIndexOf('/') || dot < base.lastIndexOf('\\')) return null;
    return TYPE_BY_EXT.get(base.slice(dot + 1).toLowerCase()) || null;
}

function firstText(rec, keys) {
    for (const k of keys) {
        const v = Object.prototype.hasOwnProperty.call(rec, k) ? rec[k] : undefined;
        if (typeof v === 'string' && v.trim()) return v;
    }
    return null;
}

function recordMime(rec) {
    const m = firstText(rec, MIME_KEYS);
    if (m) return m;
    const type = Object.prototype.hasOwnProperty.call(rec, 'type') ? rec.type : null;
    return typeof type === 'string' && type.includes('/') ? type : null;
}

/**
 * The kind of a file: one of FILE_TYPE_KEYS, from its MIME type, else its
 * name's extension. A record reads its MIME and name keys; text is a MIME or
 * a file name; a list gives one kind per entry. Null for nothing.
 */
export function fileTypeOf(value) {
    if (value == null) return null;
    if (Array.isArray(value)) return value.map(fileTypeOf);
    if (typeof value === 'string') {
        return (looksLikeMime(value) ? typeByMime(value) : null) ?? typeByExtension(value) ?? 'other';
    }
    if (!isPlainObject(value)) return null;
    const mime = recordMime(value);
    const name = firstText(value, NAME_KEYS);
    const known = (mime ? typeByMime(mime) : null) ?? (name ? typeByExtension(name) : null);
    return known ?? (mime || name ? 'other' : null);
}

/** Does this record look like a file: a MIME type, or a name with a known extension? */
export function isFileRecord(value) {
    if (!isPlainObject(value)) return false;
    const mime = recordMime(value);
    if (mime && looksLikeMime(mime)) return true;
    const name = firstText(value, NAME_KEYS);
    return !!name && typeByExtension(name) !== null;
}

const isWordChar = (c) => c !== undefined && (isDigit(c) || (c >= 'a' && c <= 'z'));

/** Earliest index of `word` in `text` with no letter or digit on either side; -1 when none. */
function wordAt(text, word) {
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
        if (!isWordChar(text[at - 1]) && !isWordChar(text[at + word.length])) return at;
    }
    return -1;
}

/** The file types a sentence names ("split by pdf, word and slides"), in the order they appear. */
export function fileTypesNamedIn(text) {
    const lower = String(text ?? '').toLowerCase();
    const out = [];
    for (const t of FILE_TYPES) {
        let best = null;
        for (const word of t.words) {
            const at = wordAt(lower, word);
            if (at >= 0 && (best === null || at < best.at)) best = { key: t.key, word, at };
        }
        if (best) out.push(best);
    }
    return out.sort((a, b) => a.at - b.at);
}

/** `fileType(<path>)`, or `fileType(<path>[*])` for the files of a list. */
export function fileTypeField(path, { list = false } = {}) {
    return `fileType(${list ? appendWildcard(path) : path})`;
}
