/**
 * normalize.mts: names and countries to the comparable form the sanctions screening works on.
 *
 *   foldText('Qoussaï Al-Tikriti')   -> 'qoussai al tikriti'
 *   nameTokens('Al-Tikriti, Qusay')  -> ['al', 'tikriti', 'qusay']
 *   tokenKeys('mohammed')            -> ['s:mt', 'p:moh']     (the lookup keys of one token)
 *   phoneticCode('qadhafi')          -> 'k_d_f_'              (what match.mts compares spellings by)
 *   countryCode('Netherlands')       -> 'NL'
 *
 * Folding: NFKD with the combining marks removed, a few letters NFKD keeps (ß, æ, ø, ł, đ, þ, ı)
 * spelled out, Cyrillic and Greek transliterated letter by letter (cheap and good enough to
 * meet a Latin spelling halfway), lower case, everything that is not a letter or digit a space.
 * Arabic, Chinese and other scripts stay as they are: they only match the same script.
 *
 * The keys are what the store indexes (stores/sanctionsStore.mts): a coarse consonant skeleton
 * (first letter kept, a leading vowel as '_', vowels, h and w dropped, look-alike consonants
 * merged, doubles collapsed) so Mohammed, Muhammad and Mohamed meet (all 'mt'), Ibrahim and
 * Ebrahim too, and a three-letter prefix for short or unusual spellings. Name particles (al,
 * abd, bin, van, de, ...) also get the keys of the name run together with them ("abd al rahman"
 * as "abdalrahman"). The keys only choose the candidates: they are coarse on purpose (Mahmoud
 * shares Mohammed's skeleton), the score comes from match.mts, which compares the finer
 * phoneticCode. Pure, no I/O.
 */

const EXTRA: Record<string, string> = {
    'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't',
};

const CYRILLIC: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'ґ': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'є': 'ye', 'ж': 'zh', 'з': 'z',
    'и': 'i', 'і': 'i', 'ї': 'yi', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
    'с': 's', 'т': 't', 'у': 'u', 'ў': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

const GREEK: Record<string, string> = {
    'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k', 'λ': 'l',
    'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f',
    'χ': 'ch', 'ψ': 'ps', 'ω': 'o',
};

/** Words that say what kind of organisation a name is, not which one. Left out of matching. */
const LEGAL_FORMS = new Set([
    'ltd', 'limited', 'llc', 'inc', 'co', 'corp', 'corporation', 'company', 'plc', 'sa', 'sarl', 'srl', 'spa',
    'bv', 'nv', 'gmbh', 'ag', 'oy', 'ab', 'as', 'jsc', 'ojsc', 'pjsc', 'cjsc', 'ooo', 'zao', 'oao', 'fze', 'fzco',
    'the', 'and', 'of',
]);

const MAX_INPUT = 300;

function mapChar(ch: string): string {
    return EXTRA[ch] ?? CYRILLIC[ch] ?? GREEK[ch] ?? ch;
}

/** Lower case, diacritics folded, transliterated, punctuation as spaces, single-spaced. */
export function foldText(input: unknown): string {
    if (typeof input !== 'string') return '';
    const lower = input.slice(0, MAX_INPUT).toLowerCase();
    let mapped = '';
    for (const ch of lower) mapped += mapChar(ch);
    const stripped = mapped.normalize('NFKD').replace(/\p{M}+/gu, '');
    return stripped.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The name's tokens, legal-form words left out (unless that would leave nothing). */
export function nameTokens(input: unknown): string[] {
    const all = foldText(input).split(' ').filter(Boolean);
    const kept = all.filter((t) => !LEGAL_FORMS.has(t));
    return kept.length ? kept : all;
}

/** The comparable form of a whole name: its tokens, joined. */
export function normalizeName(input: unknown): string {
    return nameTokens(input).join(' ');
}

const SKELETON_MAP: Record<string, string> = {
    c: 'k', q: 'k', g: 'k', z: 's', x: 's', v: 'w', b: 'p', d: 't', j: 'y',
};

const VOWELS = 'aeiou';

/** First letter (a leading vowel as '_'), then the consonants with look-alikes merged and doubles collapsed. */
export function skeleton(token: string): string {
    const t = token.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/kh/g, 'h').replace(/th/g, 't');
    if (!t) return '';
    const first = VOWELS.includes(t[0]) ? '_' : (SKELETON_MAP[t[0]] ?? t[0]);
    let out = first;
    for (const ch of t.slice(1)) {
        if ('aeiouyhw'.includes(ch)) continue;
        const m = SKELETON_MAP[ch] ?? ch;
        if (out[out.length - 1] !== m) out += m;
    }
    return out;
}

const PHONETIC_MAP: Record<string, string> = { c: 'k', q: 'k', g: 'k', z: 's', x: 's', v: 'w' };

/**
 * A spelling-tolerant code of one token, finer than the skeleton: doubles collapsed, the common
 * digraphs (ph, ck, dh, th, kh, gh, sh stay one sound), look-alike consonants merged, and every
 * run of vowels (y and w inside a word count as vowels) one '_'. The consonants and where the
 * vowels sit stay, so Qadhafi, Gaddafi and Kadhafi share 'k_d_f_', Osman and Usman '_sm_n',
 * while Mohammed ('m_h_m_d') and Mahmoud ('m_hm_d') or Ahmed and Hamid stay apart.
 */
export function phoneticCode(token: string): string {
    const t = token.replace(/(.)\1+/g, '$1').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/dh/g, 'd').replace(/th/g, 't').replace(/gh/g, 'g');
    let out = '';
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        const vowel = VOWELS.includes(ch) || (i > 0 && (ch === 'y' || ch === 'w'));
        const m = vowel ? '_' : (PHONETIC_MAP[ch] ?? ch);
        if (out[out.length - 1] !== m) out += m;
    }
    return out;
}

/** Particles that are written apart or run together with the next word ("abd al rahman", "abdulrahman"). */
export const PARTICLES = new Set(['al', 'el', 'ul', 'abd', 'abdul', 'abu', 'bin', 'ben', 'ibn', 'bint', 'van', 'von', 'der', 'den', 'de', 'di', 'da', 'du', 'la', 'le', 'ter', 'ten']);

/** The tokens with every run of particles joined to the word after it; null when nothing changes. */
export function mergeParticles(tokens: string[]): string[] | null {
    const out: string[] = [];
    let pending = '';
    for (const t of tokens) {
        if (PARTICLES.has(t)) { pending += t; continue; }
        out.push(pending + t);
        pending = '';
    }
    if (pending) out.push(pending);
    return out.length === tokens.length ? null : out;
}

/** The lookup keys of one token. Tokens of one character carry none: they would match half the list. */
export function tokenKeys(token: string): string[] {
    if (token.length < 2) return [];
    const keys = [`s:${skeleton(token)}`];
    if (token.length >= 3) keys.push(`p:${token.slice(0, 3)}`);
    return keys;
}

/** Every lookup key of a name, without duplicates. */
export function nameKeys(input: unknown): string[] {
    const out = new Set<string>();
    const tokens = nameTokens(input);
    for (const t of [...tokens, ...(mergeParticles(tokens) ?? [])]) for (const k of tokenKeys(t)) out.add(k);
    return [...out];
}

// ── Countries ───────────────────────────────────────────────────────

let countryIndex: Map<string, string> | null = null;

function buildCountryIndex(): Map<string, string> {
    const index = new Map<string, string>();
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { names = null; }
    const A = 'A'.charCodeAt(0);
    for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 26; j++) {
            const code = String.fromCharCode(A + i, A + j);
            const name = names?.of(code);
            if (!name || name === code) continue;
            index.set(foldText(name), code);
        }
    }
    // Spellings the lists use that the English display names do not.
    const extra: Record<string, string> = {
        'russian federation': 'RU', 'iran islamic republic of': 'IR', 'syrian arab republic': 'SY',
        'democratic people s republic of korea': 'KP', 'north korea': 'KP', 'republic of korea': 'KR', 'south korea': 'KR',
        'united states of america': 'US', 'usa': 'US', 'great britain': 'GB', 'united kingdom of great britain and northern ireland': 'GB',
        'the netherlands': 'NL', 'holland': 'NL', 'nederland': 'NL', 'viet nam': 'VN', 'lao people s democratic republic': 'LA',
        'democratic republic of the congo': 'CD', 'congo democratic republic of the': 'CD', 'republic of the congo': 'CG',
        'bolivia plurinational state of': 'BO', 'venezuela bolivarian republic of': 'VE', 'tanzania united republic of': 'TZ',
        'moldova republic of': 'MD', 'turkiye': 'TR', 'turkey': 'TR', 'cote d ivoire': 'CI', 'ivory coast': 'CI',
        'burma': 'MM', 'palestinian territory': 'PS', 'state of palestine': 'PS', 'czech republic': 'CZ', 'swaziland': 'SZ',
        'macedonia': 'MK', 'belarus': 'BY', 'kosovo': 'XK',
    };
    for (const [name, code] of Object.entries(extra)) index.set(name, code);
    return index;
}

/** An ISO 3166 alpha-2 code for a code or an English country name; null when it is neither. */
export function countryCode(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (/^[A-Za-z]{2}$/.test(raw)) {
        const up = raw.toUpperCase();
        return up === '00' ? null : up;
    }
    const folded = foldText(raw);
    if (!folded) return null;
    countryIndex ??= buildCountryIndex();
    return countryIndex.get(folded) ?? null;
}

/** A list's country value as it is stored: the ISO code when known, else the folded name. */
export function countryKey(input: unknown): string | null {
    if (typeof input === 'string' && input.trim() === '00') return null; // EU: "unknown"
    const code = countryCode(input);
    if (code) return code;
    const folded = foldText(input);
    return folded || null;
}

// ── Dates ───────────────────────────────────────────────────────────

/**
 * A birth date as the store keeps it: 'YYYY-MM-DD', or 'YYYY' when only the year is known.
 * Reads ISO dates, D-M-YYYY / D/M/YYYY (the Dutch and UK lists), "10 Jun 1961" (OFAC) and a
 * bare year; 'dd/mm/1945' (UK, day and month unknown) gives the year. Anything else is null.
 */
export function birthDateKey(input: unknown): string | null {
    if (typeof input === 'number' && Number.isInteger(input) && input > 1800 && input < 2200) return String(input);
    if (typeof input !== 'string') return null;
    const s = input.trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return isoDate(m[1], m[2], m[3]);
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
    if (m) return isoDate(m[3], m[2], m[1]);
    m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/.exec(s);
    if (m) {
        const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
        return month > 0 ? isoDate(m[3], String(month), m[1]) : m[3];
    }
    m = /(?:^|[^\d])(\d{4})$/.exec(s);
    if (m && Number(m[1]) > 1800 && Number(m[1]) < 2200) return m[1];
    return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: string, mo: string, d: string): string | null {
    const month = Number(mo);
    const day = Number(d);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return /^\d{4}$/.test(y) ? y : null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
