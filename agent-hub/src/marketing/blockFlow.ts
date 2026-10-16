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

function isFlat(block: CmsBlock): boolean {
    if (!FLAT_TYPES.has(block.type)) return false;
    const variant = block.content?.backgroundVariant;
    if (LEGACY_BAND_TYPES.has(block.type)) {
        if (variant !== 'default') return false;
    } else if (variant !== undefined && variant !== null && variant !== '' && variant !== 'default') {
        return false;
    }
    const s = block.style;
    if (!s) return true;
    if (s.band !== undefined && s.band !== '' && s.band !== 'default') return false;
    if (s.backgroundImage) return false;
    if (s.motif && s.motif !== 'none') return false;
    if (s.spacing?.paddingTop || s.spacing?.paddingBottom) return false;
    return true;
}

/** True when `block` should drop its top padding because `prev` already supplies the gap. */
export function joinsPreviousBlock(prev: CmsBlock | undefined, block: CmsBlock): boolean {
    return prev !== undefined && isFlat(prev) && isFlat(block);
}
