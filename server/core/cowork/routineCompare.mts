/**
 * The side-by-side proof of "make it routine": the result of the run a routine was made from, next to the result of a
 * try-out of the routine (usecases/coworkRoutine.mts). Both are split into items (a line of a list, or a sentence of
 * a short text), and an item counts as the same when most of its words are the same. "Same items: 6 of 7".
 *
 * Word overlap only: it says whether the routine finds what the AI found, not whether its words are better.
 */

const MIN_WORDS = 3;
const SAME_AT = 0.6;

const words = (line: string): Set<string> => new Set(
    line.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2),
);

/** The items of a result: its list lines when it has a list, else its sentences; short scraps left out. */
export function itemsOf(text: string): string[] {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const listed = lines.filter((l) => /^([-*•]|\d+[.)])\s/.test(l)).map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ''));
    const items = listed.length >= 2 ? listed : text.split(/(?<=[.!?])\s+/).map((s) => s.trim());
    return items.filter((i) => words(i).size >= MIN_WORDS);
}

function similar(a: Set<string>, b: Set<string>): number {
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    return shared / Math.max(1, Math.min(a.size, b.size));
}

export interface Comparison { before: number; after: number; same: number; onlyBefore: string[]; onlyAfter: string[] }

/** How many items of `before` the routine's `after` has too, and what each has that the other has not. */
export function compareResults(before: string, after: string): Comparison {
    const a = itemsOf(before);
    const b = itemsOf(after);
    const bWords = b.map(words);
    const used = new Set<number>();
    const onlyBefore: string[] = [];
    for (const item of a) {
        const w = words(item);
        const match = bWords.findIndex((bw, i) => !used.has(i) && similar(w, bw) >= SAME_AT);
        if (match >= 0) used.add(match);
        else onlyBefore.push(item);
    }
    return { before: a.length, after: b.length, same: used.size, onlyBefore, onlyAfter: b.filter((_, i) => !used.has(i)) };
}
