/**
 * "Did you mean …?" for an id a caller got slightly wrong: the automation
 * validator and the App Studio validator and builder tools all name the
 * closest real id when a model writes one that does not exist. Pure and
 * dependency-free, so both features read it from here instead of from each
 * other.
 */

/** Edit distance between two strings (insertions, deletions, substitutions). */
export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const v0: number[] = new Array(bl + 1);
    const v1: number[] = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) v0[j] = j;
    for (let i = 0; i < al; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < bl; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
        }
        for (let j = 0; j <= bl; j++) v0[j] = v1[j];
    }
    return v1[bl];
}

/**
 * Pick the closest candidate id to `target` by Levenshtein distance —
 * used to suggest "did you mean" in validation errors when an LLM
 * fabricates a step id like "step_1" that doesn't exist.
 */
export function pickClosestId<T>(target: unknown, candidates: readonly T[] | null | undefined): T | null {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const t = String(target);
    // Prefix/containment first. Minted ids are `<handle>_<hash>`, so the id a
    // model is reaching for when it writes a bare handle is almost always the
    // one that STARTS with it — but Levenshtein scores that as badly as an
    // unrelated id, because the hash dominates the distance. "loop" vs
    // "loop_812a99" is distance 7; vs "a_7918d8" it is 8. Near-identical,
    // and the right answer loses on a rounding error.
    const prefixed = candidates.filter(c => String(c).startsWith(`${t}_`) || String(c) === t);
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) return null;   // ambiguous — say nothing rather than guess

    let best: T | null = null;
    let bestDist = Infinity;
    for (const c of candidates) {
        const d = levenshtein(t, String(c));
        if (d < bestDist) { bestDist = d; best = c; }
    }
    if (bestDist <= Math.max(3, Math.floor(t.length / 2))) return best;
    // NO suggestion beats a WRONG one. Returning `candidates[0]` suggests
    // an array-order-dependent unrelated step, even after computing the
    // correct nearest match. A model acts on the sentence
    // "Did you mean X?", so a confident wrong X sends it off to edit a step
    // that was never the problem. The caller still lists every real id.
    return null;
}
