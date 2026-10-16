import Tabs from './Tabs';
import StoryHeader from './StoryHeader';
import CustomerStories from './CustomerStories';
import lazySection from './lazySection';

// The motion blocks (issue 244) are never the LCP element and bring their own
// stylesheets: they load as their own chunks, off the public entry.
const ProductMockup = lazySection(() => import('./ProductMockup'));
const CardCarousel = lazySection(() => import('./CardCarousel'));
const ScrollStory = lazySection(() => import('./ScrollStory'));
const Tour = lazySection(() => import('./Tour'));

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
};
