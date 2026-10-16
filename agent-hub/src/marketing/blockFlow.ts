import type { CmsBlock } from './ProductWebsite.types';

// Two stacked sections each carry `padding: var(--section-y) 0`, so the gap
// between their content doubles (144-224px at the default rhythm). When both
// neighbours are plain, on the page background, the lower one drops its top
// padding and the gap is one --section-y. A section that paints its own
// background (band, image, motif, explicit padding, alternate surface) needs
// both paddings, so it is never joined.

// Types whose section sits on the page background unless the block says
// otherwise. An allow-list on purpose: a type missing here keeps both paddings.
const FLAT_TYPES = new Set<string>([
    'socialProof', 'content', 'media-text', 'features', 'security', 'architecture',
    'faq', 'testimonials', 'form', 'showcase', 'feature-demo', 'roadmap',
    'compare-table', 'release-notes', 'blog-latest',
    // Legacy `alt-bg` types are flat only once the block sets backgroundVariant 'default'.
    'steps', 'integrations', 'techStats', 'pricing',
]);
const LEGACY_BAND_TYPES = new Set<string>(['steps', 'integrations', 'techStats', 'pricing']);

/** True when the block's own style paints nothing of its own (band, image, motif, padding). */
function styleIsFlat(s: CmsBlock['style']): boolean {
    if (!s) return true;
    if (s.band !== undefined && s.band !== '' && s.band !== 'default') return false;
    if (s.backgroundImage) return false;
    if (s.motif && s.motif !== 'none') return false;
    return !(s.spacing?.paddingTop || s.spacing?.paddingBottom);
}

/** True when the section's content asks for no background of its own. */
function contentIsFlat(block: CmsBlock): boolean {
    const variant = block.content?.backgroundVariant;
    if (LEGACY_BAND_TYPES.has(block.type)) return variant === 'default';
    return variant === undefined || variant === null || variant === '' || variant === 'default';
}

function isFlat(block: CmsBlock): boolean {
    return FLAT_TYPES.has(block.type) && contentIsFlat(block) && styleIsFlat(block.style);
}

/** True when `block` should drop its top padding because `prev` already supplies the gap. */
export function joinsPreviousBlock(prev: CmsBlock | undefined, block: CmsBlock): boolean {
    return prev !== undefined && isFlat(prev) && isFlat(block);
}

/** The first blocks of a page sit at or near the fold: they render at once, with no entrance animation. */
export const FIRST_BLOCKS_WITHOUT_REVEAL = 2;

/** True when the block at this position (among the rendered blocks) must not use the reveal animation. */
export function skipsReveal(position: number): boolean {
    return position < FIRST_BLOCKS_WITHOUT_REVEAL;
}

/** The flow-related wrapper options for the block at `index` of the rendered blocks. */
export function blockFlowOptions(blocks: CmsBlock[], index: number): { joined: boolean; early: boolean } {
    return { joined: joinsPreviousBlock(blocks[index - 1], blocks[index]), early: skipsReveal(index) };
}
