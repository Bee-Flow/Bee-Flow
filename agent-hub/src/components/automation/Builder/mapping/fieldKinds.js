/**
 * fieldKinds — the plain-language vocabulary for what a field IS (builder
 * redesign, artboard 2c). No "string / array / object" anywhere the user
 * looks: a field is text, a number, yes/no, a date, a list of …, a group, a
 * table, or a file — each with its own icon (FieldKindIcon.jsx) and a
 * one-line detail: "list of 3 · text", "group · 3 fields",
 * "table · 14 rows · 4 columns", "file · report.pdf · 12 KB".
 *
 * Pure and React-free, like listShape.js and upstream.js, so the auto-mapper
 * and the pickers can read the same answer. Counting a LIST is delegated to
 * listShape.pathListShape — it is the only code that flattens `[*]` columns
 * correctly, and there must never be a second walker.
 *
 * `unknown` is a real answer, not a fallback to "text": a design-time
 * placeholder (`'<string>'`, null) is not evidence of anything, and the UI
 * says "not seen yet — run the step above" rather than guessing a word.
 */
import { pathListShape } from './listShape';
import { walkPath } from '../../../../utils/bindingHelpers';

export const KINDS = Object.freeze(['text', 'email', 'number', 'yesno', 'date', 'choice', 'list', 'group', 'table', 'file', 'unknown']);

/**
 * `choice` is a scalar whose values are DECLARED, not free: a datatable's
 * `select` column, a tool parameter with an `enum`, a form's dropdown. It is
 * not a `list` (a list holds many values; a choice holds one of many) and it
 * is not plain `text` (text has no options to check a value against), and the
 * difference is what lets a mismatch say "'nope' is not one of new, won"
 * instead of "expected text, got text".
 *
 * `kindOfValue` never answers it: a value that happens to be "won" carries no
 * evidence that it came from an option list. Only a DECLARATION — a schema's
 * `enum`, a column's `type: 'select'` — can say so, which is why the only
 * producers are `expectedKindFor` and datatableDisplay's `columnTypeKind`.
 */
export const KIND_WORD = Object.freeze({
    text: { key: 'automations.kind.text', en: 'text' },
    email: { key: 'automations.kind.email', en: 'email address' },
    number: { key: 'automations.kind.number', en: 'number' },
    yesno: { key: 'automations.kind.yesno', en: 'yes/no' },
    date: { key: 'automations.kind.date', en: 'date' },
    choice: { key: 'automations.kind.choice', en: 'one of a list' },
    list: { key: 'automations.kind.list', en: 'list' },
    group: { key: 'automations.kind.group', en: 'group' },
    table: { key: 'automations.kind.table', en: 'table' },
    file: { key: 'automations.kind.file', en: 'file' },
    unknown: { key: 'automations.kind.unknown', en: 'not seen yet' },
});

/** What the kind is underneath — for tooltips and for the schema bridge. */
export const KIND_TECHNICAL = Object.freeze({
    text: 'string', email: 'string (email)', number: 'number', yesno: 'boolean', date: 'datetime',
    choice: 'string (one of)',
    list: 'array', group: 'object', table: 'array of objects', file: 'file', unknown: '?',
});

/**
 * The ONE ISO-date regex. utils/conditionModel.js used to carry its own;
 * it imports this now so a value cannot be a date in one picker and text in
 * another.
 */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;

/**
 * One e-mail address, nothing around it (round 2 leftover: the `email` kind).
 * Deliberately strict: "Jan <jan@x.nl>" or a list of addresses stays text.
 */
export const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

/** A design-time placeholder from upstream.samplePlaceholderFor — not data. */
export function isPlaceholder(v) {
    return typeof v === 'string' && /^<[a-z_ ]+>$/i.test(v.trim());
}

/** Does this object have the shape upstream.samplePlaceholderFor('file') emits? */
export function looksLikeFile(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const hasRef = 'url' in v || 'fileId' in v;
    const hasName = typeof v.name === 'string' || typeof v.filename === 'string';
    const hasMeta = 'size' in v || 'mime' in v || 'mimeType' in v;
    return hasRef && hasName && hasMeta;
}

/** Is every element (that we sampled) an object? Then it reads as a table. */
export function looksTabular(arr) {
    const sample = arr.slice(0, 20).filter(v => v !== null && v !== undefined);
    if (!sample.length) return false;
    const objects = sample.filter(v => typeof v === 'object' && !Array.isArray(v));
    return objects.length >= sample.length / 2;
}

/** The kind of ONE value. */
export function kindOfValue(v) {
    if (v === null || v === undefined) return 'unknown';
    if (Array.isArray(v)) return v.length > 0 && looksTabular(v) ? 'table' : 'list';
    const t = typeof v;
    if (t === 'number' || t === 'bigint') return 'number';
    if (t === 'boolean') return 'yesno';
    if (t === 'string') {
        if (isPlaceholder(v)) return 'unknown';
        if (ISO_DATE_RE.test(v.trim())) return 'date';
        return EMAIL_RE.test(v.trim()) ? 'email' : 'text';
    }
    if (t === 'object') return looksLikeFile(v) ? 'file' : 'group';
    return 'unknown';
}

/** "12 KB" from a byte count; null when not a number. */
export function formatBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b < 0) return null;
    if (b < 1024) return `${Math.round(b)} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Describe a picker FIELD row: `{ key, path, sample, children }` from
 * upstream.js, resolved against the merged sample root when there is one.
 *
 * @returns {{ kind:string, word:string, detail:string|null, value:*, count:number|null, of:string|null }}
 *   word   — the plain word ("list", "table", …)
 *   detail — what follows it ("of 3 · text", "· 14 rows · 4 columns"), or null
 *   `t` is optional: `t(key, en, params)`.
 */
export function describeField(field, sampleRoot = null, t = null) {
    const tr = (key, en, params) => (t ? t(key, en, params) : interpolate(en, params));
    let value = field?.sample;
    if (sampleRoot && field?.path) {
        const live = walkPath(field.path, sampleRoot);
        if (live !== undefined) value = live;
    }
    const kind = kindOfValue(value);
    const word = tr(KIND_WORD[kind].key, KIND_WORD[kind].en);

    if (kind === 'list' || kind === 'table') {
        // The count through listShape (it knows a `[*]` column's real total);
        // fall back to the element count of what we hold.
        const shape = field?.path ? pathListShape(field.path, sampleRoot) : null;
        const count = shape?.count ?? (Array.isArray(value) ? value.length : null);
        if (kind === 'table') {
            const cols = Array.isArray(value) && value.length ? Object.keys(value.find(r => r && typeof r === 'object') || {}).length : null;
            const rowsText = count === 1 ? tr('automations.kind.row', '{n} row', { n: 1 }) : tr('automations.kind.rows', '{n} rows', { n: count ?? '?' });
            const colsText = cols === 1 ? tr('automations.kind.column', '{n} column', { n: 1 }) : tr('automations.kind.columns', '{n} columns', { n: cols ?? '?' });
            return { kind, word, value, count, of: 'records', detail: `· ${rowsText} · ${colsText}` };
        }
        const first = Array.isArray(value) ? value.find(x => x !== null && x !== undefined) : undefined;
        const elemKind = first === undefined ? null : kindOfValue(first);
        const elemWord = elemKind ? tr(KIND_WORD[elemKind].key, KIND_WORD[elemKind].en) : null;
        if (count === 0) return { kind, word, value, count, of: null, detail: tr('automations.kind.list_empty', '· empty') };
        return {
            kind, word, value, count, of: elemKind,
            detail: count == null
                ? (elemWord ? tr('automations.kind.list_of_kind', 'of {kind}', { kind: elemWord }) : null)
                : (elemWord
                    ? tr('automations.kind.list_of_n_kind', 'of {n} · {kind}', { n: count, kind: elemWord })
                    : tr('automations.kind.list_of_n', 'of {n}', { n: count })),
        };
    }
    if (kind === 'group') {
        const n = Object.keys(value).length;
        return { kind, word, value, count: n, of: null, detail: tr('automations.kind.group_fields', '· {n} fields', { n }) };
    }
    if (kind === 'file') {
        const name = value.name || value.filename || '';
        const size = formatBytes(value.size);
        return { kind, word, value, count: null, of: null, detail: [name, size].filter(Boolean).map(x => `· ${x}`).join(' ') || null };
    }
    if (kind === 'text' && typeof value === 'string' && value.length > 120) {
        // "text · 2 paragraphs" (design 1h) — a blob is not a value you read
        // in a row, so say its size instead of its first forty characters.
        const paragraphs = value.split(/\n\s*\n/).filter(x => x.trim()).length;
        const words = value.trim().split(/\s+/).length;
        const detail = paragraphs > 1
            ? tr('automations.kind.paragraphs', '· {n} paragraphs', { n: paragraphs })
            : tr('automations.kind.words', '· {n} words', { n: words });
        return { kind, word, value, count: null, of: null, detail };
    }
    return { kind, word, value, count: null, of: null, detail: null };
}

/**
 * What KIND a tool parameter wants, from its JSON schema — the sibling of
 * listShape.expectedShapeFor, one level finer. 'unknown' means the chooser
 * and the empty-slot note stay silent.
 */
export function expectedKindFor(schemaProp) {
    if (!schemaProp || typeof schemaProp !== 'object') return 'unknown';
    let type = schemaProp.type;
    if (Array.isArray(type)) type = type.find(x => x !== 'null') || type[0];
    const fmt = String(schemaProp.format || '').toLowerCase();
    // A declared option list is the evidence `choice` needs. Checked before
    // the plain-string answer so a `{type:'string', enum:[…]}` slot can say
    // WHICH values it takes rather than "text" — the enum half of the
    // mismatch story. `format` still wins: a dated enum is a date.
    if (Array.isArray(schemaProp.enum) && schemaProp.enum.length
        && (type === 'string' || type === undefined) && fmt !== 'date' && fmt !== 'date-time') {
        return 'choice';
    }
    if (type === 'string') {
        if (fmt === 'date' || fmt === 'date-time') return 'date';
        return fmt === 'email' ? 'email' : 'text';
    }
    if (type === 'number' || type === 'integer') return 'number';
    if (type === 'boolean') return 'yesno';
    if (type === 'array') return schemaProp.items?.type === 'object' ? 'table' : 'list';
    if (type === 'object') return 'group';
    return 'unknown';
}

/** Is this kind a single value (as opposed to a list, table or group)? */
export function isScalarKind(kind) {
    return kind === 'text' || kind === 'email' || kind === 'number' || kind === 'yesno'
        || kind === 'date' || kind === 'choice';
}

/**
 * Would a field of `actual` kind fit a slot that wants `expected`? Advisory —
 * the server does no type checking, so this only ever decides what the UI
 * says. Text accepts every scalar (bind.js stringifies safely); a list slot
 * accepts a list or a table; anything unknown fits (a claim needs evidence).
 */
export function kindFits(actual, expected) {
    if (!expected || expected === 'unknown' || !actual || actual === 'unknown') return true;
    if (actual === expected) return true;
    if (expected === 'text') return isScalarKind(actual);
    // A choice slot takes any scalar: whether the VALUE is one of the options
    // is a question about the value, not about its kind, and the server is
    // the one that answers it. Refusing here would flag every binding into a
    // dropdown as a mismatch. A choice binds into a text slot for the same
    // reason (isScalarKind above).
    if (expected === 'choice') return isScalarKind(actual);
    // An address slot takes plain text too: most addresses arrive as text
    // (a form answer, a header), and the kind is a hint, not a validator.
    if (expected === 'email') return actual === 'text';
    if (expected === 'list') return actual === 'table';
    return false;
}

function interpolate(en, params) {
    if (!params) return en;
    return String(en).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
