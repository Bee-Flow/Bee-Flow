import { PII_CATEGORIES } from '../../../../../../config/piiCategories';

/**
 * "Your own data": the shapes and the pure rules behind the tab.
 *
 * Mirrors the pinned REST contract (the stored type in the shield document,
 * and the encrypted tests row). No React and no English here: every function
 * returns a code or a number, and the components pick the words. That keeps
 * the rules testable without a render and keeps the i18n guard happy.
 *
 * The server is the authority on every rule mirrored here (token key, caps,
 * pattern safety). The client copy only exists so an admin hears "that name
 * is taken" while typing instead of after Save.
 */

export type Method = 'words' | 'pattern' | 'ai';
export type SwitchCol = 'detect' | 'external' | 'internal';
export type SentenceOrigin = 'assistant' | 'nearmiss' | 'own' | 'feedback';

export interface WordsSpec { values: string[]; caseSensitive: boolean; wholeWord: boolean }
export interface PatternSpec { source: string; caseSensitive: boolean; engine?: 're2' | 'v8-legacy'; error?: string }
export interface AiSpec { prompt: string; floor: number; groupSignature?: string }
export interface Quality { found: number; total: number; falseAlarms: number; sentences: number; at?: string; stale?: boolean }

export interface CustomDataType {
    id: string;
    name: string;
    description: string;
    method: Method;
    tokenKey: string;
    words?: WordsSpec;
    pattern?: PatternSpec;
    ai?: AiSpec;
    quality?: Quality;
    status?: 'invalid';
    origin: 'created' | 'migrated';
    legacy?: true;
    createdAt?: string;
    createdBy?: string;
    updatedAt?: string;
}

export interface Span { start: number; end: number }

/**
 * A test sentence. `gold` is what should be hidden in it, and its ABSENCE is
 * meaningful: no `gold` means "not marked yet" (a find is only a find, and the
 * sentence is not scored), while `gold: []` means "nothing should be hidden
 * here" (a near miss, where any find is a false alarm).
 */
export interface Sentence {
    id: string;
    text: string;
    gold?: Span[];
    origin: SentenceOrigin;
}

export interface TypeTests {
    examples: string[];
    keepFixed?: string[];
    sentences: Sentence[];
    updatedAt?: string;
}

export type TestsDoc = Record<string, TypeTests>;

export interface Summary { found: number; total: number; falseAlarms: number; sentences: number }

export interface ShieldLists {
    piiCategories: string[];
    toolPiiPolicy: {
        external: { blockCategories: string[] };
        internal: { blockCategories: string[] };
    };
}

/** Caps from the contract. The server enforces them; these only shape the UI. */
export const LIMITS = {
    types: 50,
    aiTypes: 6,
    name: 60,
    description: 400,
    words: 500,
    word: 120,
    pattern: 300,
    examples: 10,
    example: 100,
    sentences: 40,
    sentence: 300,
    gold: 5,
    promptMin: 2,
    promptMax: 60,
} as const;

export const CUSTOM_TYPE_ID_RE = /^cdt_[0-9a-f]{10}$/;
export const TOKEN_KEY_RE = /^[a-z](?:[a-z0-9_]{0,30}[a-z])?$/;
/** The token key every migrated legacy term keeps, so `[customterm_N]` survives. */
export const LEGACY_TOKEN_KEY = 'customterm';

export function isCustomTypeId(id: unknown): id is string {
    return typeof id === 'string' && CUSTOM_TYPE_ID_RE.test(id);
}

/** `cdt_` + 10 lowercase hex, from the browser's CSPRNG. */
export function newTypeId(): string {
    const bytes = new Uint8Array(5);
    globalThis.crypto.getRandomValues(bytes);
    return `cdt_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

// ── Token keys ───────────────────────────────────────────────────────────

/**
 * Mirror of the server's TOKEN_WORDS keys (core/privacy/piiDetection/
 * tokenNeutralise.js). A custom placeholder that collides with one of these
 * would be rewritten into the wrong noun ("[phone_1]" read as a phone number).
 */
const TOKEN_WORDS = [
    'email', 'emailaddress', 'person', 'name', 'phone', 'phonenumber', 'creditcard',
    'creditcardnumber', 'iban', 'bankaccount', 'ssn', 'ussocialsecuritynumber', 'nationalid',
    'nationalidentificationnumber', 'bsn', 'passport', 'passportnumber', 'driverlicense',
    'address', 'location', 'organization', 'organisation', 'org', 'company', 'url', 'ip',
    'ipaddress', 'date', 'dob', 'dateofbirth', 'medical', 'vat', 'taxid',
];

const compact = (s: string): string => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every key a custom type may not use, compared without separators. */
export const RESERVED_TOKEN_KEYS: ReadonlySet<string> = new Set([
    ...PII_CATEGORIES.map(c => compact(c.id)),
    ...TOKEN_WORDS,
    'data', 'pii', LEGACY_TOKEN_KEY, 'custom',
]);

export type TokenKeyProblem = 'format' | 'reserved' | 'taken';

/**
 * Why `key` cannot be this type's placeholder, or null when it can.
 *
 * A migrated legacy type may keep `customterm` unchanged: that is the one
 * exception the contract makes, so an edit that leaves the key alone must
 * not be refused.
 */
export function tokenKeyProblem(
    key: string,
    types: readonly CustomDataType[],
    self?: Pick<CustomDataType, 'id' | 'tokenKey' | 'legacy'> | null,
): TokenKeyProblem | null {
    if (self?.legacy && key === self.tokenKey && key === LEGACY_TOKEN_KEY) return null;
    // TOKEN_KEY_RE is anchored, one bounded repeat and no nesting: linear.
    if (!TOKEN_KEY_RE.test(key)) return 'format'; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    if (RESERVED_TOKEN_KEYS.has(compact(key))) return 'reserved';
    const mine = compact(key);
    if (types.some(t => t.id !== self?.id && compact(t.tokenKey) === mine)) return 'taken';
    return null;
}

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'of', 'or', 'and', 'for', 'our', 'my', 'your', 'to', 'in', 'on', 'with',
    'de', 'het', 'een', 'van', 'en',
]);

const singular = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/**
 * A readable placeholder key from a type's name.
 *
 * "Project code names" becomes `project_code`, "Customer numbers"
 * `customer_number`. Plural and filler words are dropped because the key
 * shows up in every placeholder the AI reads: `[project_code_1]` reads as
 * one value, `[project_code_names_1]` as a list. Empty when nothing usable
 * is left (a name of digits and symbols).
 */
export function tokenKeyFromName(name: string): string {
    const ascii = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    let words = ascii.split(/[^a-z0-9]+/).filter(w => w && !STOP_WORDS.has(w)).map(singular);
    if (words.length > 1 && words[words.length - 1] === 'name') words = words.slice(0, -1);
    const key = words.slice(0, 3).join('_').replace(/^[^a-z]+/, '').slice(0, 32).replace(/[^a-z]+$/, '');
    return TOKEN_KEY_RE.test(key) ? key : '';
}

/**
 * The key a new type gets for its name: the readable one when it is free,
 * otherwise the first free variant. Never returns a reserved or taken key,
 * so a starter never opens on a validation error.
 */
export function suggestTokenKey(
    name: string,
    types: readonly CustomDataType[],
    self?: Pick<CustomDataType, 'id' | 'tokenKey' | 'legacy'> | null,
): string {
    const base = tokenKeyFromName(name) || 'own_data';
    const stem = base.slice(0, 26).replace(/[^a-z]+$/, '');
    const candidates = [base, `own_${stem}`.slice(0, 32).replace(/[^a-z]+$/, '')];
    for (const letter of 'bcdefghjkmnpqrstuvwxyz') candidates.push(`${stem}_${letter}`);
    return candidates.find(k => tokenKeyProblem(k, types, self) === null) || base;
}

// ── Types ────────────────────────────────────────────────────────────────

/**
 * A fresh draft. It carries all three method blocks so switching method in
 * the wizard and back again keeps what was typed; `toStoredType` keeps only
 * the chosen one, as the contract requires.
 */
export function emptyType(method: Method = 'words'): CustomDataType {
    return {
        id: newTypeId(),
        name: '',
        description: '',
        method,
        tokenKey: '',
        origin: 'created',
        words: { values: [], caseSensitive: false, wholeWord: true },
        pattern: { source: '', caseSensitive: false },
        ai: { prompt: '', floor: 0.5 },
    };
}

/** A stored type as a draft: the missing blocks filled with defaults. */
export function toDraft(type: CustomDataType): CustomDataType {
    const blank = emptyType(type.method);
    return {
        ...type,
        words: type.words ? { ...blank.words!, ...type.words } : blank.words,
        pattern: type.pattern ? { ...blank.pattern!, ...type.pattern } : blank.pattern,
        ai: type.ai ? { ...blank.ai!, ...type.ai } : blank.ai,
    };
}

/** What the AI label defaults to before tuning has picked a better wording. */
export function defaultPrompt(name: string): string {
    const clean = String(name || '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return clean.slice(0, LIMITS.promptMax).trim();
}

/**
 * The draft as the server should see it: only the active block, the AI
 * label filled in from the name when nothing chose one yet, and the
 * server-owned fields (`status`, the pattern `error`) dropped so a stale
 * verdict is never echoed back as if it were the admin's.
 */
export function resolveType(draft: CustomDataType): CustomDataType {
    const {
        words: _w, pattern: _p, ai: _a, status: _status, ...rest
    } = draft;
    const out: CustomDataType = { ...rest, name: draft.name.trim(), description: draft.description.trim() };
    if (draft.method === 'words') out.words = resolveWords(draft.words);
    else if (draft.method === 'pattern') out.pattern = resolvePattern(draft.pattern);
    else out.ai = { prompt: draft.ai?.prompt?.trim() || defaultPrompt(draft.name), floor: draft.ai?.floor ?? 0.5 };
    return out;
}

function resolveWords(words: WordsSpec | undefined): WordsSpec {
    return {
        values: (words?.values || []).map(v => v.trim()).filter(Boolean),
        caseSensitive: !!words?.caseSensitive,
        wholeWord: words?.wholeWord !== false,
    };
}

function resolvePattern(pattern: PatternSpec | undefined): PatternSpec {
    const out: PatternSpec = { source: pattern?.source || '', caseSensitive: !!pattern?.caseSensitive };
    if (pattern?.engine) out.engine = pattern.engine;
    return out;
}

/** Only the parts that change what gets found, so a rename is not a retest. */
export function configFingerprint(type: CustomDataType): string {
    const r = resolveType(type);
    return JSON.stringify([r.method, r.words, r.pattern, r.ai]);
}

export function markStale(type: CustomDataType): CustomDataType {
    return type.quality ? { ...type, quality: { ...type.quality, stale: true } } : type;
}

// ── Status and verdicts (codes only; the components word them) ──────────

export type TypeStatus =
    | { kind: 'invalid'; reason: string }
    | { kind: 'paused' }
    | { kind: 'untested' }
    | { kind: 'stale' }
    | { kind: 'tested'; found: number; total: number; falseAlarms: number };

/**
 * One row's test-result cell.
 *
 * Invalid outranks everything (the type is stored but not enforced). On a
 * plan without the feature, only migrated legacy types stay enforced, so
 * every other type is paused whatever its last test said.
 */
export function statusFor(type: CustomDataType, { licensed }: { licensed: boolean }): TypeStatus {
    if (type.status === 'invalid' || type.pattern?.error) {
        return { kind: 'invalid', reason: type.pattern?.error || '' };
    }
    if (!licensed && !type.legacy) return { kind: 'paused' };
    const q = type.quality;
    if (!q || !Number.isFinite(q.total)) return { kind: 'untested' };
    if (q.stale) return { kind: 'stale' };
    return { kind: 'tested', found: q.found, total: q.total, falseAlarms: q.falseAlarms };
}

export type Verdict = 'no_gold' | 'perfect' | 'good' | 'misses' | 'too_much';

/**
 * The plain verdict under the read-out. "Good enough" means at least 90%
 * found with at most one false alarm, or 5% of the sentences on a big set.
 */
export function verdictFor(s: Summary): Verdict {
    if (!s || s.total <= 0) return 'no_gold';
    if (s.found >= s.total && s.falseAlarms === 0) return 'perfect';
    const ratio = s.found / s.total;
    if (ratio >= 0.9 && s.falseAlarms <= Math.max(1, 0.05 * s.sentences)) return 'good';
    if (ratio < 0.9) return 'misses';
    return 'too_much';
}

// ── The three switches: ids in the existing category lists ──────────────

export function builtInOnly(ids: readonly string[] | undefined): string[] {
    return (ids || []).filter(id => !isCustomTypeId(id));
}

export function customOnly(ids: readonly string[] | undefined): string[] {
    return (ids || []).filter(id => isCustomTypeId(id));
}

export function switchesFor(lists: ShieldLists, id: string): Record<SwitchCol, boolean> {
    return {
        detect: (lists.piiCategories || []).includes(id),
        external: (lists.toolPiiPolicy?.external?.blockCategories || []).includes(id),
        internal: (lists.toolPiiPolicy?.internal?.blockCategories || []).includes(id),
    };
}

/** Add or remove one id from one list, leaving the order of the rest alone. */
export function toggleId(list: readonly string[] | undefined, id: string, on: boolean): string[] {
    const cur = list || [];
    if (on) return cur.includes(id) ? [...cur] : [...cur, id];
    return cur.filter(x => x !== id);
}

/** How many of the org's types use the AI method (capped at six). */
export function aiTypeCount(types: readonly CustomDataType[], exceptId?: string): number {
    return types.filter(t => t.method === 'ai' && t.id !== exceptId).length;
}
