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
     * This destination's label in the server's GUI string catalogue; `label` is
     * its English, the fallback that renders until the catalogue has it.
     *
     * The WEB's own key (`sidebar.agents`, `settings.appearance`) wherever the
     * web says the same thing: a string an administrator has already
     * translated for the browser then appears on the phone with nobody
     * translating it twice, and the two clients cannot drift into calling the
     * same screen different things in Dutch. Where the web has no such key it
     * is the row's own `mobile.sitemap.<id>.label`.
     *
     * Every row has one (nav/destination.ts writes both phrases of a row down
     * as `{ i18nKey, en }`); optional in the type because the readers outside
     * this feature only ever branch on it.
     */
    i18nKey?: string;
    /**
     * The hint's key, with `hint` its English: the web's (its Studio section
     * descriptions, `settings.memory_desc`: then `hint` is the web's English
     * word for word, and sitemap.i18n.test.ts holds the two together) or the
     * row's own `mobile.sitemap.<id>.hint`. Every row has one.
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
