/**
 * What picking an app should do to the brief you already have.
 *
 * The Cowork composer used to call `onChange(seed)` flat out, so one click on
 * Gmail threw away half a paragraph of typed brief — no confirmation, no undo,
 * on a perfectly normal action. A seed is a sentence *starter*, not a
 * replacement, so it is appended to whatever is there.
 *
 * The joining rule, in one place because both the composer and its tests need
 * to agree on it:
 *  - an empty (or whitespace-only) box is simply seeded, with no leading blank
 *    line to delete afterwards;
 *  - a brief that already ends in whitespace is continued in place — several
 *    seeds are half-sentences ending in a space themselves ("Search my
 *    contacts for ");
 *  - anything else gets a newline between the two sentences, because a brief
 *    and a seed are two instructions, not one run-on line.
 */
export function appendAppSeed(current, seed) {
    const text = String(seed || '');
    if (!text) return String(current ?? '');
    const base = String(current ?? '');
    if (!base.trim()) return text;
    return /\s$/.test(base) ? base + text : base + '\n' + text;
}

export default appendAppSeed;
