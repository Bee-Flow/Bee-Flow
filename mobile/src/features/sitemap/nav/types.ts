/**
 * The shape of a sitemap row, and the groups the rows are filed under.
 *
 * `gate` is deliberately coarse. It names what the DESTINATION needs, and the
 * map uses it only to hide rows that would certainly 403 (or that the product
 * keeps away from a role, like the operator's Administration screen); anything
 * ambiguous stays visible, because a screen that says "not available on your
 * plan" is far better than a screen that does not exist and leaves the user
 * hunting.
 */

import type { Gate } from '@/core/access';
import type { IconName } from '@/shared/ui';

export type SitemapGroup = 'Workspace' | 'Content' | 'Organisation' | 'Account' | 'Help';

export interface Destination {
    /** Stable key — used for the list key, not shown. */
    id: string;
    label: string;
    /** One line, sentence case. It is also matched by the search field. */
    hint: string;
    icon: IconName;
    /** An in-app route, or an absolute URL opened in the browser. */
    href: string;
    group: SitemapGroup;
    /** Extra words that should match in search but are not worth showing. */
    keywords?: string[];
    /**
     * This destination's label in the server's GUI string catalogue.
     *
     * Deliberately the WEB's own key (`sidebar.agents`, `settings.appearance`)
     * rather than a mobile-specific one: a string an administrator has already
     * translated for the browser then appears on the phone with nobody
     * translating it twice, and the two clients cannot drift into calling the
     * same screen different things in Dutch.
     *
     * Absent where the catalogue has no key for it — inventing one would put a
     * key in the haystack that resolves to its own English fallback, which
     * matches nothing a Dutch user would type and costs a comparison.
     */
    i18nKey?: string;
    /**
     * The hint's key, where the web already says the same thing (its Studio
     * section descriptions): then `hint` is the web's English, word for word,
     * and sitemap.i18n.test.ts holds the two together. Absent elsewhere —
     * those hints are the phone's own and stay English until the dictionary
     * stage lands a `mobile.*` key for them.
     */
    hintKey?: string;
    /**
     * Who may be offered this row, as a core/access gate (a permission, an
     * admin role, a licence). Omit when everyone may at least look.
     */
    gate?: Gate;
    /** True for destinations that leave the app. */
    external?: boolean;
}

export const GROUP_ORDER: SitemapGroup[] = [
    'Workspace',
    'Content',
    'Organisation',
    'Account',
    'Help',
];
