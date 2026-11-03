/**
 * The last pairing tier of file_intake: a drawing and a CAD file whose names
 * say the same part in different words.
 *
 * The earlier tiers (pairing.js) cover identical names, safe normalisations, a
 * prefix and a sheet number. Two real kinds of order still fell through:
 *   - "<name>_drawing.pdf" beside "<name>_8mm.dxf": the drawing says what it is,
 *     the CAD file says how thick the plate is;
 *   - the CAD file's name carries one extra word, e.g. the machine it is cut on,
 *     inside an otherwise identical long name.
 *
 * So both names become word tokens, minus the words that say WHAT KIND of file
 * it is or a property of the plate rather than WHICH part: "drawing"-like words,
 * a sheet number, a revision, a thickness. Two names pair when their tokens are
 * the same, or one has exactly one token more; and the shared part must carry
 * enough of a part number (5+ digits, or 2+ tokens) to be more than a word in
 * common. pairing.js pairs only when that is the ONE candidate on both sides.
 *
 * Works on canonical keys (naming.js normalizeBase): lowercase, separators as '-'.
 */

const NOISE_WORDS = new Set(['drawing', 'drawings', 'tekening', 'tekeningen', 'dwg', 'tek', 'plan']);
const SHEET_WORD = /^(?:sheet|sht|blad)$/;
const SHEET_TOKEN = /^(?:sheet|sht|blad)\d{1,2}$/;
const REV_WORD = /^(?:rev|revisie)$/;
const REV_TOKEN = /^(?:rev|revisie)[a-z0-9]{1,3}$/;
const SHORT_CODE = /^[a-z0-9]{1,3}$/;
const DIGITS_1_2 = /^\d{1,2}$/;
const THICKNESS = /^(?:\d+(?:\.\d+)?mm|t\d+(?:\.\d+)?)$/;
const MIN_DIGITS = 5;
const MIN_TOKENS = 2;

/** The tokens that name the part: separators split, kind-of-file and plate words dropped. */
export function partTokens(key: string): string[] {
    // A dot between two digits is a decimal ("8.5mm"), anywhere else a separator.
    const raw = String(key || '').toLowerCase().split(/[-_ ]+|(?<!\d)\.|\.(?!\d)/).filter((t) => t && t !== 'x');
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
        const tok = raw[i];
        const next = raw[i + 1];
        if (NOISE_WORDS.has(tok) || SHEET_TOKEN.test(tok) || REV_TOKEN.test(tok) || THICKNESS.test(tok)) continue;
        if (SHEET_WORD.test(tok)) { if (next !== undefined && DIGITS_1_2.test(next)) i += 1; continue; }
        if (REV_WORD.test(tok)) { if (next !== undefined && SHORT_CODE.test(next)) i += 1; continue; }
        out.push(tok);
    }
    return out;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * True when `longer` is `shorter` with exactly one WORD inserted somewhere. A word, not a number:
 * "12345-1" beside "12345" is a sheet or a variant (naming.js isSheetOf decides those), never
 * "the same part with one more word".
 */
function oneWordMore(longer: string[], shorter: string[]): boolean {
    if (longer.length !== shorter.length + 1) return false;
    for (let skip = 0; skip < longer.length; skip++) {
        if (!/[a-z]/.test(longer[skip])) continue;
        if (sameList([...longer.slice(0, skip), ...longer.slice(skip + 1)], shorter)) return true;
    }
    return false;
}

function enoughSignal(shared: string[]): boolean {
    let digits = 0;
    for (const tok of shared) for (const ch of tok) if (ch >= '0' && ch <= '9') digits += 1;
    return digits >= MIN_DIGITS || shared.length >= MIN_TOKENS;
}

/** Do these two canonical names say the same part (see the header)? Symmetric. */
export function samePartByTokens(a: string, b: string): boolean {
    const x = partTokens(a);
    const y = partTokens(b);
    if (!x.length || !y.length) return false;
    const [longer, shorter] = x.length >= y.length ? [x, y] : [y, x];
    const match = sameList(longer, shorter) || oneWordMore(longer, shorter);
    return match && enoughSignal(shorter);
}
