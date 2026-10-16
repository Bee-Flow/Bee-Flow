import { lazy, Suspense, type ComponentType } from 'react';

/**
 * A section in its own chunk, so its JS and CSS stay off the public entry.
 * For blocks that are never the page's LCP element (the motion blocks of
 * issue 244). The chunk loads when a page renders the block; until then a
 * placeholder with the section's usual minimum height holds the space
 * (`.cms-lazy-section`, marketing.css), so the page below shifts as little as
 * possible. Carries its own Suspense boundary: the registry, the editor
 * preview and the section thumbnails render it like any other section.
 */
export default function lazySection<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
    const Section = lazy(load);
    function LazySection(props: P) {
        return (
            <Suspense fallback={<div className="cms-lazy-section" aria-busy="true" />}>
                <Section {...props} />
            </Suspense>
        );
    }
    return LazySection;
}
