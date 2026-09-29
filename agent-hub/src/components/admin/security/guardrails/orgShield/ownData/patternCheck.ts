/**
 * Browser-side pattern helpers for the "fixed format" method.
 *
 * Two jobs, both advisory. The server compiles every pattern with RE2 and is
 * the only authority on whether it is accepted; these exist so an admin sees
 * "Matches 3 of 3 examples" while typing, and so a type built from examples
 * has a pattern to test with before anyone has written one.
 */

export type PatternCheck =
    | { ok: false; reason: 'empty' | 'too_long' | 'invalid'; message?: string }
    | { ok: true; matched: number; total: number; misses: string[] };

const MAX_SOURCE = 300;

/** Compile a source the way the matcher does: global, case flag optional. */
export function compilePattern(source: string, caseSensitive = false): RegExp | null {
    try {
        return new RegExp(source, caseSensitive ? 'g' : 'gi');
    } catch {
        return null;
    }
}

/** Does the WHOLE example match? A partial match would pass `KL-1` for `KL-\d{5}`-shaped data. */
function fullMatch(re: RegExp, example: string): boolean {
    re.lastIndex = 0;
    const m = re.exec(example);
    re.lastIndex = 0;
    return !!m && m.index === 0 && m[0].length === example.length;
}

export function checkPattern(source: string, examples: readonly string[], caseSensitive = false): PatternCheck {
    if (!source || !source.trim()) return { ok: false, reason: 'empty' };
    if (source.length > MAX_SOURCE) return { ok: false, reason: 'too_long' };
    let re: RegExp;
    try {
        re = new RegExp(source, caseSensitive ? 'g' : 'gi');
    } catch (e) {
        return { ok: false, reason: 'invalid', message: e instanceof Error ? e.message : String(e) };
    }
    // A pattern that matches the empty string would hide nothing and loop
    // forever in a naive matcher; the server refuses it, so say so here too.
    if (fullMatch(re, '')) return { ok: false, reason: 'invalid' };
    const misses = examples.filter(ex => !fullMatch(re, ex));
    return { ok: true, matched: examples.length - misses.length, total: examples.length, misses };
}

type RunClass = 'digit' | 'upper' | 'lower' | 'other';
interface Run { cls: RunClass; text: string }

const classOf = (ch: string): RunClass => {
    if (/[0-9]/.test(ch)) return 'digit';
    if (/[A-Z]/.test(ch)) return 'upper';
    if (/[a-z]/.test(ch)) return 'lower';
    return 'other';
};

/** "KL-12345" → [upper "KL", other "-", digit "12345"]. Each symbol is its own run. */
function runsOf(value: string): Run[] {
    const out: Run[] = [];
    for (const ch of value) {
        const cls = classOf(ch);
        const last = out[out.length - 1];
        if (last && last.cls === cls && cls !== 'other') last.text += ch;
        else out.push({ cls, text: ch });
    }
    return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CLASS_RE: Record<Exclude<RunClass, 'other'>, string> = {
    digit: '\\d',
    upper: '[A-Z]',
    lower: '[a-z]',
};

function quantifier(lengths: number[]): string {
    const min = Math.min(...lengths);
    const max = Math.max(...lengths);
    return min === max ? `{${min}}` : `{${min},${max}}`;
}

function runPattern(column: Run[]): string {
    const first = column[0];
    if (column.every(r => r.text === first.text)) return escapeRe(first.text);
    if (first.cls === 'other') return '';
    return `${CLASS_RE[first.cls]}${quantifier(column.map(r => r.text.length))}`;
}

/**
 * A starting pattern from real examples, or '' when they do not share one
 * shape. Deterministic and deliberately simple: the parts every example
 * shares are kept literally ("KL-"), the parts that vary become a character
 * class with the observed length ("\d{5}"). Word boundaries at both ends,
 * so `KL-\d{5}` does not match the first five digits of a longer number.
 */
export function inferPattern(examples: readonly string[]): string {
    const values = examples.map(e => e.trim()).filter(Boolean);
    if (values.length === 0) return '';
    const shapes = values.map(runsOf);
    const len = shapes[0].length;
    const sameShape = shapes.every(s => s.length === len && s.every((r, i) => r.cls === shapes[0][i].cls));
    if (!sameShape) return '';
    const parts: string[] = [];
    for (let i = 0; i < len; i++) {
        const part = runPattern(shapes.map(s => s[i]));
        if (!part) return '';
        parts.push(part);
    }
    const lead = shapes[0][0].cls === 'other' ? '' : '\\b';
    const tail = shapes[0][len - 1].cls === 'other' ? '' : '\\b';
    return `${lead}${parts.join('')}${tail}`;
}
