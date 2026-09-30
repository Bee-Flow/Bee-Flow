/**
 * The app's shell: the navigation drawer (the web sidebar, natively) and the
 * slim bottom bar under it. app/(drawer)/_layout.tsx renders DrawerLayout and
 * app/(drawer)/(tabs)/_layout.tsx renders TabsLayout. Import from
 * '@/features/shell'.
 *
 * The top of the feature graph: it composes chat, agents, projects, apps,
 * forms, approvals, cowork, notifications and Studio, and nothing imports it
 * but app/. The sitemap it used to hold lives in features/sitemap, below the
 * search feature that reads it.
 */

export { DrawerLayout } from './screens/DrawerLayout';
export { StudioTabScreen } from './screens/StudioTabScreen';
export { TabsLayout } from './screens/TabsLayout';
