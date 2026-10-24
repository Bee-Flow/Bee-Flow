/**
 * Heading anchors, as the web's MarkdownRenderer makes them: every heading
 * gets a slug of its text, and a `#fragment` link in the same answer scrolls
 * to the heading whose slug it names — or, failing that, to the first heading
 * whose letters and digits contain the fragment's (or the other way round),
 * because models write `#step-2-install` for a heading "Step 2: Installing".
 * headingSlug and anchorKey are the web's own functions (generated copy of markdownRules.ts).
 */

import { anchorKey, headingSlug } from '../mirror/markdownRules';

export { anchorKey, headingSlug };

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
