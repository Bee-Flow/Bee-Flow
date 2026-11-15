import { describe, it, expect } from 'vitest';
import { linkHref, resolveBlockProps } from './blockProps';

const origin = window.location.origin;

describe('resolveBlockProps', () => {
    it('turns a CMS asset key into an absolute public URL and keeps a URL', () => {
        const out = resolveBlockProps(
            [{ name: 'photo', type: 'image' }, { name: 'logo', type: 'image' }, { name: 'none', type: 'image' }],
            { photo: 'cms/site 1/a b.png', logo: 'https://cdn.example.org/l.svg', none: '' },
        );
        expect(out.photo).toBe(`${origin}/api/cms/asset/cms/site%201/a%20b.png`);
        expect(out.logo).toBe('https://cdn.example.org/l.svg');
        expect(out.none).toBe('');
    });

    it('takes the href of a link the public site resolved, or the string the editor preview left', () => {
        const out = resolveBlockProps(
            [{ name: 'more', type: 'link' }, { name: 'docs', type: 'link' }],
            { more: { href: '/pricing', target: '_blank' }, docs: 'https://docs.example.org/' },
        );
        expect(out.more).toBe(`${origin}/pricing`);
        expect(out.docs).toBe('https://docs.example.org/');
    });

    it('finds a link the editor preview moved (link -> href, ctaLink -> ctaHref)', () => {
        const out = resolveBlockProps(
            [{ name: 'link', type: 'link' }, { name: 'ctaLink', type: 'link' }],
            { href: '/?slug=about', ctaHref: '#signup' },
        );
        expect(out.link).toBe(`${origin}/?slug=about`);
        expect(String(out.ctaLink)).toMatch(/#signup$/);
    });

    it('passes every other prop through, declared or not, and survives junk', () => {
        expect(resolveBlockProps([{ name: 'n', type: 'number' }, null, { type: 'text' }], { n: 3, extra: true })).toEqual({ n: 3, extra: true });
        expect(resolveBlockProps('nope', ['x'])).toEqual({});
    });
});

describe('linkHref', () => {
    it('reads a raw link object too', () => {
        expect(linkHref({ kind: 'external', url: 'https://a.example/' })).toBe('https://a.example/');
        expect(linkHref({ kind: 'anchor', anchor: 'faq' })).toBe('#faq');
        expect(linkHref({ kind: 'app', path: '' })).toBe('/');
        expect(linkHref({ kind: 'page', pageId: 'p1' })).toBe('');
        expect(linkHref(42)).toBe('');
    });
});
