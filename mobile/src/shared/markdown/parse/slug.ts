/**
 * Heading anchors, as the web's MarkdownRenderer makes them: every heading
 * gets a slug of its text, and a `#fragment` link in the same answer scrolls
 * to the heading whose slug it names — or, failing that, to the first heading
 * whose letters and digits contain the fragment's (or the other way round),
 * because models write `#step-2-install` for a heading "Step 2: Installing".
 * slug.test.ts runs the web's own functions beside these.
 */

/** The web's slug: lower case, letters/digits/spaces/hyphens kept, spaces to hyphens. */
export function headingSlug(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/** The web's fuzzy form of a fragment or a heading: `[a-z0-9]` only. */
export function anchorKey(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface AnchorHeading {
    slug: string;
    text: string;
}

/**
 * The heading a `#fragment` link points at: its exact slug first, then the
 * web's fuzzy match over the headings in document order.
 */
export function findAnchor<T extends AnchorHeading>(fragment: string, headings: readonly T[]): T | undefined {
    const id = fragment.replace(/^#/, '');
    const exact = headings.find((h) => h.slug === id);
    if (exact) return exact;
    const wanted = anchorKey(id);
    if (!wanted) return undefined;
    return headings.find((h) => {
        const key = anchorKey(h.text);
        return key.includes(wanted) || wanted.includes(key);
    });
}
