/**
 * The sitemap: every place a person can go, as data (nav/destinations), the
 * filters over it, and the A–Z screen that renders it. The global search reads
 * the same list for its "places" group. Import from '@/features/sitemap'.
 *
 * Its own feature, below the shell: the drawer composes chat, and chat's
 * share-intent reaches the search feature, which reads this list — so a
 * sitemap inside features/shell would close a cycle.
 */

export { DESTINATIONS } from './nav/destinations';
export { isReachable, matchesSearch } from './nav/search';
export { GROUP_ORDER, type Destination, type SitemapGroup } from './nav/types';
export { SitemapScreen } from './screens/SitemapScreen';
