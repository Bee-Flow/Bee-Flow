import { describe, it, expect } from 'vitest';
import { joinsPreviousBlock } from './blockFlow';
import type { CmsBlock } from './ProductWebsite.types';

const block = (type: string, extra: Partial<CmsBlock> = {}): CmsBlock => ({ id: `${type}_1`, type, ...extra });

describe('joinsPreviousBlock', () => {
    it('joins two plain sections so their padding is not added up', () => {
        expect(joinsPreviousBlock(block('features'), block('faq'))).toBe(true);
    });

    it('never joins the first block', () => {
        expect(joinsPreviousBlock(undefined, block('features'))).toBe(false);
    });

    it('keeps both paddings around a hero', () => {
        expect(joinsPreviousBlock(block('hero'), block('features'))).toBe(false);
        expect(joinsPreviousBlock(block('features'), block('hero'))).toBe(false);
    });

    it('keeps both paddings around a coloured band', () => {
        const dark = block('features', { style: { band: 'dark' } });
        expect(joinsPreviousBlock(dark, block('faq'))).toBe(false);
        expect(joinsPreviousBlock(block('faq'), dark)).toBe(false);
        expect(joinsPreviousBlock(block('faq'), block('faq', { style: { band: 'default' } }))).toBe(true);
    });

    it('keeps both paddings around a background image, a motif or explicit padding', () => {
        expect(joinsPreviousBlock(block('faq'), block('features', { style: { backgroundImage: 'cms/a.png' } }))).toBe(false);
        expect(joinsPreviousBlock(block('faq'), block('features', { style: { motif: 'honeycomb' } }))).toBe(false);
        expect(joinsPreviousBlock(block('faq'), block('features', { style: { spacing: { paddingTop: '2rem' } } }))).toBe(false);
    });

    it('treats a section with its own background variant as a band', () => {
        const surface = block('features', { content: { backgroundVariant: 'surface' } });
        expect(joinsPreviousBlock(surface, block('faq'))).toBe(false);
        expect(joinsPreviousBlock(block('faq'), block('features', { content: { backgroundVariant: 'default' } }))).toBe(true);
    });

    it('treats types that draw their own alternate background as banded', () => {
        expect(joinsPreviousBlock(block('steps'), block('faq'))).toBe(false);
        expect(joinsPreviousBlock(block('faq'), block('pricing'))).toBe(false);
        expect(joinsPreviousBlock(block('steps', { content: { backgroundVariant: 'default' } }), block('faq'))).toBe(true);
    });
});
