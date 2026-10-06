/**
 * Schema matching for auto-map, without a language model.
 *
 * autoMapInputs first tries exact and normalised name matches; this is the
 * layer after that, for what a person would still call "obviously that one":
 *
 *   accountId   ← Mail accounts ▸ id        (the step names the entity)
 *   title       ← subject                    (synonym)
 *   recipientEmail ← to                      (synonym + the value is an e-mail)
 *   fileUrl     ← link                       (synonym + the value is a URL)
 *
 * It scores every (parameter, upstream field) pair on four kinds of evidence,
 * the way classic matchers (COMA, Cupid) combine them:
 *
 *   name      token overlap after splitting camelCase/snake_case, singular
 *             forms and a small synonym table; a generic field name (`id`,
 *             `name`, `email`) borrows the entity words of its step and path
 *   value     what the sample looks like (an e-mail, a URL, a date, a number)
 *             against what the parameter asks for (type, format, its name)
 *   meaning   words of the parameter's description that the field shares
 *   nearness  a closer step wins a tie
 *
 * and assigns greedily, best pair first, one field per parameter and one
 * parameter per field. A pair needs real name evidence, or an unmistakable
 * value kind the parameter names (an "email" parameter and exactly one
 * e-mail address nearby). Conservative on purpose: a wrong guess costs the
 * author more than an empty field.
 *
 * Pure and framework-free. Port of agent-hub `Builder/mapping/schemaMatch.ts`,
 * held to it by autoMap.lockstep.test.ts (the web auto-map uses it).
 */

import { parsePath } from '@/shared/expr';

export interface MatchParam {
    key: string;
    type?: string | string[];
    format?: string;
    description?: string;
    /** Allowed values: a sample that is one of them is strong evidence. */
    enum?: unknown[];
}

export interface MatchCandidate {
    key: string;
    path: string;
    sample?: unknown;
    /** The step's label ("Mail accounts"): entity words for a generic key. */
    groupLabel?: string;
    /** Higher = nearer to the step being mapped. */
    groupIndex: number;
    fieldIndex?: number;
}

export interface MatchResult { key: string; path: string; score: number }

// ── words ───────────────────────────────────────────────────────────────────

const SYNONYMS: Record<string, string[]> = {
    subject: ['subject', 'title', 'topic', 'heading', 'headline'],
    body: ['body', 'content', 'text', 'contents'],
    email: ['email', 'emailaddress', 'mailaddress'],
    from: ['from', 'sender', 'author'],
    to: ['to', 'recipient', 'receiver', 'addressee'],
    file: ['file', 'document', 'doc'],
    url: ['url', 'link', 'href', 'uri', 'weburl'],
    phone: ['phone', 'telephone', 'tel', 'mobile', 'phonenumber'],
    folder: ['folder', 'directory', 'dir'],
    date: ['date', 'day'],
    time: ['time', 'datetime', 'timestamp'],
    id: ['id', 'identifier', 'uid'],
    amount: ['amount', 'total', 'sum'],
    description: ['description', 'summary', 'details'],
    company: ['company', 'organization', 'organisation', 'org', 'business'],
};
const CANON = new Map<string, string>();
for (const [canon, words] of Object.entries(SYNONYMS)) for (const w of words) CANON.set(w, canon);

// Words that say nothing about WHAT a value is.
const NOISE = new Set(['the', 'a', 'an', 'of', 'value', 'field', 'input', 'output', 'result', 'results', 'steps', 'loop', 'data', 'item', 'items', 'my', 'new']);

function singular(w: string): string {
    if (w.length <= 2) return w;
    if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
    if (/(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
    if (/(ss|us|is)$/.test(w)) return w;
    return w.endsWith('s') ? w.slice(0, -1) : w;
}

/** `recipientEmailAddress` → ['to', 'email', 'address'] (canonical, singular). Accents do not count (`Prénom` → prenom). */
export function tokens(name: string): string[] {
    const raw = String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const joined = raw.join('');
    // A whole name that is itself a synonym ("emailaddress") stays one word.
    if (raw.length > 1 && CANON.has(joined)) return [CANON.get(joined)!];
    const out: string[] = [];
    for (const w of raw) {
        const s = singular(w);
        if (NOISE.has(w) || NOISE.has(s)) continue;
        const c = CANON.get(w) || CANON.get(s) || s;
        if (!out.includes(c)) out.push(c);
    }
    return out;
}

// ── value kinds ─────────────────────────────────────────────────────────────

type Kind = 'email' | 'url' | 'date' | 'number' | 'boolean' | 'text' | 'list' | 'record' | 'unknown';

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
const NAMED_EMAIL_RE = /<[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}>$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
// RFC 2822, as mail headers carry it: "Tue, 29 Sep 2026 03:13:26 +0000 (UTC)".
const MAIL_DATE_RE = /^(?:[A-Z][a-z]{2}, )?\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}(:\d{2})? [+-]\d{4}/;

export function valueKind(v: unknown): Kind {
    if (v == null || v === '') return 'unknown';
    if (Array.isArray(v)) return 'list';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'object') return 'record';
    const s = String(v).trim();
    if (EMAIL_RE.test(s) || NAMED_EMAIL_RE.test(s)) return 'email';
    if (URL_RE.test(s)) return 'url';
    if (DATE_RE.test(s) || MAIL_DATE_RE.test(s)) return 'date';
    return 'text';
}

/** What a parameter's format and name say it wants; null when they say nothing. */
function namedKind(p: MatchParam, words: string[]): Kind | null {
    if (p.format === 'email' || words.includes('email')) return 'email';
    if (p.format === 'uri' || p.format === 'url' || words.includes('url')) return 'url';
    if (p.format === 'date' || p.format === 'date-time' || words.includes('date') || words.includes('time')) return 'date';
    return null;
}

const TYPE_KIND: Record<string, Kind> = { number: 'number', integer: 'number', boolean: 'boolean', array: 'list', object: 'record', string: 'text' };

function wantedKind(p: MatchParam, words: string[]): Kind {
    const named = namedKind(p, words);
    if (named) return named;
    const t = Array.isArray(p.type) ? p.type.find(x => x !== 'null') : p.type;
    return (t && TYPE_KIND[t]) || 'unknown';
}

/** May a value of kind `have` fill a parameter that wants `want`? */
function kindFits(want: Kind, have: Kind): boolean {
    if (want === 'unknown' || have === 'unknown') return true;
    if (want === have) return true;
    if (want === 'text') return have !== 'list' && have !== 'record';
    // A "12" string is not trusted as a number, and plain text is no e-mail
    // address, URL or date: the kinds below only take their own kind.
    return false;
}

// ── scoring ─────────────────────────────────────────────────────────────────

const GENERIC = new Set(['id', 'name', 'email', 'url', 'title', 'subject', 'date', 'time', 'path', 'key']);

// Keys that only wrap a payload say nothing about the entity a field belongs to.
const WRAPPER_WORDS = new Set(['data', 'result', 'results', 'value', 'values', 'items', 'payload', 'body', 'response', 'record', 'records', 'attributes', 'fields', 'properties', 'output', 'object', 'content']);

function entityWords(c: MatchCandidate): string[] {
    // Path segments before the key (`…attachments[*].id` → attachment), then
    // the step's own label ("Mail accounts" → mail, account). Read with the
    // runtime grammar, so `["line-items"]` is a segment like any other.
    const keys = ((parsePath(String(c.path || '')) || []) as { type: string; key?: unknown }[])
        .filter(t => t.type !== 'wild' && typeof t.key === 'string')
        .map(t => t.key as string);
    // `steps.<id>` and `loop.<name>` say nothing; nor does `trigger`.
    const skip = keys[0] === 'steps' || keys[0] === 'loop' ? 2 : 1;
    const segs = keys.slice(skip, -1).filter(s => !/^output$|^s?[a-z]+_[0-9a-f]{4,}$/i.test(s) && !WRAPPER_WORDS.has(s.toLowerCase()));
    return [...tokens(segs.join(' ')), ...tokens(c.groupLabel || '')];
}

/** Name evidence, 0..1: the parameter's words the field (or, for a generic key, its step) says. */
function nameScore(P: string[], c: MatchCandidate): number {
    const C = tokens(c.key);
    // A generic key (`id`) borrows the entity words of its path and step,
    // but only when the parameter needs them (accountId ← accounts ▸ id).
    const covered = C.length > 0 && C.every(w => P.includes(w));
    const ctx = covered && C.some(w => GENERIC.has(w)) ? entityWords(c) : [];
    const pool = new Set([...C, ...ctx]);
    const hit = P.filter(w => pool.has(w)).length;
    const score = hit / Math.max(P.length, C.length);
    // Every word of the field must be something the parameter says, or a
    // longer field name ("billingAddressLine2") would ride on one shared word.
    return C.some(w => !P.includes(w)) ? score * 0.6 : score;
}

/** Value and meaning evidence on top of the name. */
function bonuses(p: MatchParam, c: MatchCandidate, want: Kind, have: Kind): number {
    const valueBonus = want !== 'unknown' && want !== 'text' && want === have ? 0.25 : 0;
    // Instance evidence: the sample is one of the parameter's allowed values.
    const enumBonus = Array.isArray(p.enum) && p.enum.some(e => String(e) === String(c.sample)) ? 0.3 : 0;
    const desc = tokens(p.description || '');
    const meaning = desc.length && tokens(c.key).some(w => desc.includes(w)) ? 0.1 : 0;
    return valueBonus + enumBonus + meaning;
}

export function scorePair(p: MatchParam, c: MatchCandidate, maxGroup: number): number {
    const P = tokens(p.key);
    if (!P.length) return 0;
    const want = wantedKind(p, P);
    const have = valueKind(c.sample);
    if (!kindFits(want, have)) return 0;
    const near = maxGroup > 0 ? 0.05 * (c.groupIndex / maxGroup) : 0.05;
    return nameScore(P, c) + bonuses(p, c, want, have) + near;
}

const ACCEPT = 0.85;

/**
 * Best assignment for the still-empty parameters. `taken` holds paths already
 * bound (by the exact-name tiers or the author); they are not offered again.
 */
export function matchSchema(params: MatchParam[], candidates: MatchCandidate[], taken: Set<string> = new Set()): MatchResult[] {
    const maxGroup = Math.max(0, ...candidates.map(c => c.groupIndex));
    const pairs: MatchResult[] = [];
    for (const p of params) {
        const P = tokens(p.key);
        const want = wantedKind(p, P);
        for (const c of candidates) {
            if (taken.has(c.path)) continue;
            const score = scorePair(p, c, maxGroup);
            if (score >= ACCEPT) pairs.push({ key: p.key, path: c.path, score });
        }
        // Value evidence alone: the parameter names a kind ("email", "url")
        // and exactly one field of that kind sits in the nearest step that has any.
        if (want === 'email' || want === 'url') {
            const ofKind = candidates.filter(c => !taken.has(c.path) && valueKind(c.sample) === want);
            const nearest = Math.max(-1, ...ofKind.map(c => c.groupIndex));
            const there = ofKind.filter(c => c.groupIndex === nearest);
            const only = there.length === 1 ? there[0] : undefined;
            if (only && !pairs.some(x => x.key === p.key)) pairs.push({ key: p.key, path: only.path, score: ACCEPT });
        }
    }
    pairs.sort((a, b) => b.score - a.score);
    const out: MatchResult[] = [];
    const keysDone = new Set<string>();
    const pathsDone = new Set<string>();
    for (const r of pairs) {
        if (keysDone.has(r.key) || pathsDone.has(r.path)) continue;
        out.push(r);
        keysDone.add(r.key);
        pathsDone.add(r.path);
    }
    return out;
}
