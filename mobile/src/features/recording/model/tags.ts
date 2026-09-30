/**
 * Editing a note's tags on the phone, by the server's rules (the `tags`
 * branch of PATCH /:id in routes/transcriptions/noteActions.js): trimmed,
 * at most 80 characters each, no duplicates, at most 50 per note. Applying
 * them here means the chips show what the server will keep.
 */

export const MAX_TAG_LENGTH = 80;
export const MAX_TAGS = 50;

/** One typed entry may hold several tags: "sales, q3" is two. */
export function parseTagInput(input: string): string[] {
    return input
        .split(',')
        .map((part) => part.trim().slice(0, MAX_TAG_LENGTH))
        .filter(Boolean);
}

/** One exact tag (a picked suggestion may itself contain a comma). */
export function withTag(tags: readonly string[], tag: string): string[] {
    const clean = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (!clean || tags.includes(clean) || tags.length >= MAX_TAGS) return [...tags];
    return [...tags, clean];
}

/** Everything typed into the field, split on commas. */
export function addTags(tags: readonly string[], input: string): string[] {
    return parseTagInput(input).reduce<string[]>((acc, tag) => withTag(acc, tag), [...tags]);
}

export function removeTag(tags: readonly string[], tag: string): string[] {
    return tags.filter((t) => t !== tag);
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** The vocabulary's tags this note does not carry yet, most-used first. */
export function suggestedTags(vocabulary: readonly { tag: string; count: number }[], current: readonly string[]): string[] {
    return vocabulary
        .filter((r) => r.tag && !current.includes(r.tag))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .map((r) => r.tag);
}
