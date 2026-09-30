/**
 * "Suggest outputs", part one: picking the field a rule compares. What the
 * author NAMES wins over every heuristic; the heuristics never guess below a
 * minimum score, because a rule against the wrong field matches nothing at run
 * time and reports no error. From agent-hub
 * `Builder/flow/settings/routeIntents.js`; pinned by settings.lockstep.test.ts.
 */

export interface IntentField {
    path?: string;
    label?: string;
    sample?: unknown;
    [key: string]: unknown;
}

/**
 * File "types" as a person names them versus the extensions that occur —
 * "word" is two extensions, "powerpoint" two. Aliases match on word boundaries.
 */
export const FILE_TYPES: readonly { key: string; aliases: string[]; extensions: string[] }[] = [
    { key: 'pdf', aliases: ['pdf', 'pdfs'], extensions: ['.pdf'] },
    { key: 'word', aliases: ['word', 'doc', 'docx', 'msword'], extensions: ['.doc', '.docx'] },
    { key: 'excel', aliases: ['excel', 'xls', 'xlsx', 'spreadsheet', 'spreadsheets'], extensions: ['.xls', '.xlsx'] },
    { key: 'powerpoint', aliases: ['powerpoint', 'ppt', 'pptx', 'presentation', 'presentations'], extensions: ['.ppt', '.pptx'] },
    { key: 'image', aliases: ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'jpg', 'jpeg', 'png'], extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'] },
    { key: 'csv', aliases: ['csv'], extensions: ['.csv'] },
    { key: 'text_file', aliases: ['txt'], extensions: ['.txt'] },
    { key: 'archive', aliases: ['zip', 'archive', 'archives'], extensions: ['.zip'] },
    { key: 'audio', aliases: ['audio', 'mp3', 'recording', 'recordings'], extensions: ['.mp3', '.wav', '.m4a'] },
    { key: 'video', aliases: ['video', 'videos', 'mp4'], extensions: ['.mp4', '.mov', '.mkv'] },
];

const ALL_EXTENSIONS = FILE_TYPES.flatMap((t) => t.extensions);

function lastSegment(path: unknown): string {
    const cleaned = String(path || '').replace(/\[(?:\*|\d+)\]/g, '');
    return cleaned.split('.').filter(Boolean).pop() || '';
}

export function fieldKey(field: IntentField | null | undefined): string {
    return lastSegment(field?.path).toLowerCase();
}

const FILE_NAME_KEYS = /^(file|files|filename|file_name|name|path|filepath|attachment|attachments|document)$/;
const TEXT_KEYS = /^(subject|title|name|body|text|message|content|description|summary|snippet)$/;
const NUMBER_KEYS = /(amount|total|price|count|quantity|qty|score|size|bytes|number|age|days)$/;
const DATE_KEYS = /(date|created|updated|modified|due|sent|received|timestamp|time|at)$/;

function bestField(fields: IntentField[], score: (f: IntentField) => number, minimum = 2): IntentField | null {
    let best: IntentField | null = null;
    let bestScore = 0;
    for (const f of fields || []) {
        if (!f?.path) continue;
        const s = score(f);
        if (s > bestScore) {
            best = f;
            bestScore = s;
        }
    }
    return bestScore >= minimum ? best : null;
}

const sampleString = (f: IntentField): string | null => (typeof f.sample === 'string' ? f.sample : null);

/** A sample that ends in a known extension beats any name (an address ends in ".nl"). */
export function pickFileField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => {
        const sample = sampleString(f);
        const hasExt = sample !== null && ALL_EXTENSIONS.some((e) => sample.toLowerCase().endsWith(e));
        const key = fieldKey(f);
        const named = FILE_NAME_KEYS.test(key) ? 2 : key === 'title' ? 1 : 0;
        return (hasExt ? 3 : 0) + named;
    });
}

export function pickTextField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => (typeof f.sample === 'string' ? 1 : 0) + (TEXT_KEYS.test(fieldKey(f)) ? 2 : 0));
}

export function pickNumberField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => (typeof f.sample === 'number' ? 3 : 0) + (NUMBER_KEYS.test(fieldKey(f)) ? 2 : 0));
}

export function pickDateField(fields: IntentField[]): IntentField | null {
    return bestField(fields, (f) => {
        const sample = sampleString(f);
        const dated = sample !== null && /^\d{4}-\d{2}-\d{2}/.test(sample.trim());
        return (dated ? 3 : 0) + (DATE_KEYS.test(fieldKey(f)) ? 2 : 0);
    });
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A field the author NAMED in the description; longest match wins ("from email" over "from"). */
export function namedField(lower: string, fields: IntentField[]): IntentField | null {
    let best: IntentField | null = null;
    let bestLen = 0;
    for (const f of fields || []) {
        if (!f?.path) continue;
        const candidates = [f.label, fieldKey(f).replace(/_/g, ' '), fieldKey(f)].filter(Boolean).map((s) => String(s).toLowerCase());
        for (const c of candidates) {
            if (c.length < 3 || c.length <= bestLen) continue;
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an escapeRe-escaped literal between two single-character alternatives, with no quantifier, so each position costs at most the length of the field name
            if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(c)}(?:[^a-z0-9]|$)`).test(lower)) {
                best = f;
                bestLen = c.length;
            }
        }
    }
    return best;
}

function aliasIndex(lower: string, alias: string): number {
    const m = new RegExp(`(?:^|[^a-z0-9])(${alias})(?:[^a-z0-9]|$)`).exec(lower);
    return m ? m.index + m[0].indexOf(alias) : -1;
}

/** The file types named, in the order the author named them. */
export function findFileTypes(lower: string): (typeof FILE_TYPES)[number][] {
    const hits: { t: (typeof FILE_TYPES)[number]; at: number }[] = [];
    for (const t of FILE_TYPES) {
        let at = -1;
        for (const a of t.aliases) {
            const i = aliasIndex(lower, a);
            if (i >= 0 && (at < 0 || i < at)) at = i;
        }
        if (at >= 0) hits.push({ t, at });
    }
    return hits.sort((a, b) => a.at - b.at).map((h) => h.t);
}
