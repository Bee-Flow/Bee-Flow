import { describe, expect, it } from 'vitest';
import {
    NODE_W, PADDING,
    bfsLayout, classifyInternal, collectChromeTargets, collectInternalEdges,
} from './sitemapGraph';
import type { SitemapPage } from './sitemapGraph';

const link = (pageId: string) => ({ kind: 'page', pageId });

const pages: SitemapPage[] = [
    { id: 'home', isHomepage: true, blocks: [{ id: 'b1', type: 'hero', cta: link('about') }] },
    { id: 'about', blocks: [{ id: 'b2', type: 'content', items: [link('team'), link('home')] }] },
    { id: 'team', blocks: [] },
    { id: 'pricing', blocks: [] },
    { id: 'lost', blocks: [{ id: 'b3', type: 'content', link: link('about') }] },
];

describe('sitemapGraph', () => {
    it('collects chrome targets with where they are defined', () => {
        const { targets, sources } = collectChromeTargets({ header: { nav: [{ link: link('pricing') }] }, footer: [link('pricing')] });
        expect([...targets]).toEqual(['pricing']);
        expect(sources.get('pricing')).toEqual([{ location: 'header' }, { location: 'footer' }]);
    });

    it('collects deduped internal edges and the blocks that define them', () => {
        const { edges, meta } = collectInternalEdges(pages);
        expect(edges).toEqual([
            { source: 'home', target: 'about' },
            { source: 'about', target: 'team' },
            { source: 'about', target: 'home' },
            { source: 'lost', target: 'about' },
        ]);
        expect(meta.get('home->about')).toEqual([{ blockType: 'hero', blockId: 'b1' }]);
    });

    it('ranks by BFS from the homepage, seeds chrome targets at rank 1 and buckets orphans', () => {
        const { edges } = collectInternalEdges(pages);
        const layout = bfsLayout(pages, edges, new Set(['pricing']));
        expect(layout.homepageId).toBe('home');
        expect([...layout.orphanIds]).toEqual(['lost']);
        const y = (id: string) => layout.positions.get(id)!.y;
        expect(y('about')).toBe(y('pricing'));
        expect(y('team')).toBeGreaterThan(y('about'));
        expect(y('lost')).toBe(layout.orphanRowY);
        expect(layout.chromePos).not.toBeNull();
        expect(layout.canvasWidth).toBe(2 * NODE_W + 36 + 2 * PADDING);
        expect(classifyInternal({ source: 'about', target: 'team' }, layout.parent)).toBe('tree');
        expect(classifyInternal({ source: 'about', target: 'home' }, layout.parent)).toBe('backlink');
    });
});
