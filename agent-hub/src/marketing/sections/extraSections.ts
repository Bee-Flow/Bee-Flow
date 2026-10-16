import Tabs from './Tabs';
import StoryHeader from './StoryHeader';
import CustomerStories from './CustomerStories';

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
};
