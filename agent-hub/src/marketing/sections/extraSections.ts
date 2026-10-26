import Tabs from './Tabs';
import StoryHeader from './StoryHeader';
import lazySection from './lazySection';
// Shared by StoryHeader (eager) and CustomerStories (lazy); imported here once so it stays in the main stylesheet.
import './stories.css';

// The motion blocks (issue 244) are never the LCP element and bring their own
// stylesheets: they load as their own chunks, off the public entry.
const ProductMockup = lazySection(() => import('./ProductMockup'));
const CardCarousel = lazySection(() => import('./CardCarousel'));
const ScrollStory = lazySection(() => import('./ScrollStory'));
const Tour = lazySection(() => import('./Tour'));

// Below-the-fold sections that bring heavy imports (the demo registry, the
// integration logos) or their own stylesheet: own chunks, off the public entry.
const Integrations = lazySection(() => import('./Integrations'));
const CustomerSupport = lazySection(() => import('./CustomerSupport'));
const FeatureDemo = lazySection(() => import('./FeatureDemo'));
const GitHubStats = lazySection(() => import('./GitHubStats'));
const ReleaseNotes = lazySection(() => import('./ReleaseNotes'));
const CustomerStories = lazySection(() => import('./CustomerStories'));
const CompareTable = lazySection(() => import('./CompareTable'));
const Roadmap = lazySection(() => import('./Roadmap'));

/**
 * Sections registered by block type outside ProductWebsite.jsx, which sits at
 * its file-size ceiling: new section types are added here and spread into
 * SECTION_REGISTRY. Same contract as the registry: block type -> component
 * receiving the block content as `data`.
 */
export const EXTRA_SECTIONS = {
    tabs: Tabs,
    'story-header': StoryHeader,
    'customer-stories': CustomerStories,
    'product-mockup': ProductMockup,
    'card-carousel': CardCarousel,
    scrollStory: ScrollStory,
    tour: Tour,
    integrations: Integrations,
    'customer-support': CustomerSupport,
    'feature-demo': FeatureDemo,
    'github-stats': GitHubStats,
    'release-notes': ReleaseNotes,
    'compare-table': CompareTable,
    roadmap: Roadmap,
};
