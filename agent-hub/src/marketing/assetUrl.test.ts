import { describe, it, expect } from 'vitest';
import { assetSrcSet } from './assetUrl';

describe('assetSrcSet', () => {
    it('lists WebP width variants for an uploaded image', () => {
        const set = assetSrcSet('/api/cms/asset/cms/1-a-hero.png');
        expect(set).toContain('/api/cms/asset/cms/1-a-hero.png?w=640 640w');
        expect(set?.split(', ')).toHaveLength(5);
    });

    it('leaves svg, gif, video, external and already-sized urls alone', () => {
        expect(assetSrcSet('/api/cms/asset/cms/1-a.svg')).toBeUndefined();
        expect(assetSrcSet('/api/cms/asset/cms/1-a.gif')).toBeUndefined();
        expect(assetSrcSet('/api/cms/asset/cms/1-a.mp4')).toBeUndefined();
        expect(assetSrcSet('https://example.com/a.png')).toBeUndefined();
        expect(assetSrcSet('/api/cms/asset/cms/1-a.png?w=320')).toBeUndefined();
    });
});
