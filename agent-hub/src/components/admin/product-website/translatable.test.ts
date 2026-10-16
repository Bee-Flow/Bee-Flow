import { describe, it, expect } from 'vitest';
import {
    isDeniedKey, isTranslatableValue, collectStrings, labelForPath,
    buildPageGroups, coverageForLocale, collectMedia,
} from './translatable';
import type { FieldPath, FoundString, TranslatableRow } from './translatable';

const PAGE = {
    id: 'pg_1', slug: 'home', title: 'Home',
    seo: { metaTitle: 'Acme — Home', metaDescription: 'Welcome' },
    blocks: [
        {
            id: 'b1', type: 'hero', enabled: true,
            content: {
                lead: 'Fly with us',
                titleParts: [{ text: 'Hello' }, { text: 'World' }],
                titleStyle: { color: '#fff', fontFamily: 'Inter' },   // denied subtree
                primaryCta: { label: 'Go', link: { kind: 'page', pageId: 'pg_1' } },
            },
        },
        { id: 'b2', type: 'cta', enabled: true, content: { title: 'Ready?', buttonUrl: 'https://x.test' } },
    ],
};

describe('field enumeration (server-parity rules)', () => {
    it('denies structural keys and *Style/*Url-suffixed keys', () => {
        expect(isDeniedKey('link')).toBe(true);
        expect(isDeniedKey('titleStyle')).toBe(true);
        expect(isDeniedKey('buttonUrl')).toBe(true);
        expect(isDeniedKey('lead')).toBe(false);
        // A/B bookkeeping is an identifier Umami groups on; the alternative copy is prose.
        expect(isDeniedKey('abKey')).toBe(true);
        expect(isDeniedKey('abGoal')).toBe(true);
        expect(isDeniedKey('abAlt')).toBe(false);
    });
    it('rejects colors, URLs and empty strings as values', () => {
        expect(isTranslatableValue('#ff00aa')).toBe(false);
        expect(isTranslatableValue('https://x.test')).toBe(false);
        expect(isTranslatableValue('/pricing')).toBe(false);
        expect(isTranslatableValue('  ')).toBe(false);
        expect(isTranslatableValue('Hello')).toBe(true);
    });
    it('collects exactly the translatable leaves of a block', () => {
        const out: FoundString[] = [];
        collectStrings(PAGE.blocks[0].content, [], out);
        expect(out.map(o => o.fieldPath.join('.'))).toEqual([
            'lead', 'titleParts.0.text', 'titleParts.1.text', 'primaryCta.label',
        ]);
    });
    it('labels paths with friendly names and item positions', () => {
        expect(labelForPath(['lead'])).toBe('Lead paragraph');
        expect(labelForPath(['items', 1, 'title'])).toBe('Title (#2)');
    });
});

describe('groups + coverage', () => {
    it('builds Page & SEO + per-block groups with override values', () => {
        const pageOv = { version: 1, blocks: { b1: { content: { lead: 'Vlieg met ons' } } } };
        const groups = buildPageGroups(PAGE, pageOv, null);
        expect(groups.map(g => g.key)).toEqual(['meta', 'b1', 'b2']);
        const leadRow = groups[1].rows.find(r => (r.target as { fieldPath: FieldPath }).fieldPath.join('.') === 'lead') as TranslatableRow;
        expect(leadRow.value).toBe('Vlieg met ons');
    });
    it('computes site-wide coverage without double-counting page titles', () => {
        const site = { pages: [{ id: 'pg_1', slug: 'home', title: 'Home', isHomepage: true }], header: null, footer: null };
        const empty = coverageForLocale(site, [PAGE], { siteByLocale: {}, pagesByLocale: {} }, 'nl');
        // 1 page title (site scope) + metaTitle + metaDescription + 5 block leaves
        expect(empty.total).toBe(8);
        expect(empty.done).toBe(0);
        const some = coverageForLocale(site, [PAGE], {
            siteByLocale: { nl: { pageTitles: { pg_1: 'Thuis' } } },
            pagesByLocale: { pg_1: { nl: { blocks: { b1: { content: { lead: 'Vlieg' } } } } } },
        }, 'nl');
        expect(some.done).toBe(2);
        expect(some.total).toBe(8);
    });
});

describe('roadmap status is structural, not prose', () => {
    // A roadmap item's `status` is the value Roadmap.jsx buckets on. Translated
    // to 'bèta' it matches no bucket and the item drops out of the page with no
    // error anywhere. The LABELS are prose and must keep translating.
    it('denies `status` but not `statusLabels`', () => {
        expect(isDeniedKey('status')).toBe(true);
        expect(isDeniedKey('statusLabels')).toBe(false);
    });

    it('collects the labels and the item copy, but never the status value', () => {
        const out: FoundString[] = [];
        collectStrings(
            {
                statusLabels: { beta: 'In beta' },
                items: [{ title: 'Legal', body: 'A matter file', note: 'Dutch law only', status: 'beta' }],
            },
            [],
            out,
        );
        const paths = out.map(e => e.fieldPath.join('.'));
        expect(paths).toContain('statusLabels.beta');
        expect(paths).toContain('items.0.title');
        expect(paths).toContain('items.0.note');
        expect(paths.some(p => p.endsWith('.status'))).toBe(false);
    });
});

describe('per-language media', () => {
    const MEDIA_PAGE = {
        id: 'pg_m', slug: 'm', title: 'Media',
        blocks: [{
            id: 'bm', type: 'media-text', enabled: true,
            content: { title: 'Intro', media: { src: 'cms/en.mp4', poster: '', kind: 'clip', alt: 'Clip' }, items: [{ media: { src: 'cms/a.png', srcDark: 'cms/a-dark.png' } }, { title: 'No media' }] },
        }],
    };

    it('lists the addresses of every media slot, only for keys the default already has', () => {
        const found: FoundString[] = [];
        collectMedia(MEDIA_PAGE.blocks[0].content, [], found);
        expect(found.map(f => f.fieldPath.join('.'))).toEqual([
            'media.src', 'media.poster', 'items.0.media.src', 'items.0.media.srcDark',
        ]);
    });

    it('never treats a media address as text, so AI translate and the text list skip it', () => {
        const text: FoundString[] = [];
        collectStrings(MEDIA_PAGE.blocks[0].content, [], text);
        expect(text.map(f => f.source)).toEqual(['Intro', 'Clip', 'No media']);
        expect(isDeniedKey('poster')).toBe(true);
    });

    it('adds media rows to the block group, flagged, and keeps them out of the coverage count', () => {
        const groups = buildPageGroups(MEDIA_PAGE, {}, {});
        const rows: TranslatableRow[] = groups.flatMap(g => g.rows).filter(r => r.media);
        expect(rows.map(r => r.label)).toContain('Media address for this language (image or clip)');
        expect(rows.length).toBe(4);
        const cov = coverageForLocale({ pages: [] } as never, [MEDIA_PAGE] as never, { pagesByLocale: {}, siteByLocale: {} } as never, 'nl');
        expect(cov.total).toBe(3);
    });
});

describe('stored override values that are not text', () => {
    it('counts a non-string value at a translated path as untranslated instead of passing it on', () => {
        const override = { seo: { metaTitle: 42 }, blocks: { b1: { content: { lead: { nested: true } } } } };
        const rows: TranslatableRow[] = buildPageGroups(PAGE as never, override, {}).flatMap(g => g.rows);
        expect(rows.filter(r => r.value !== undefined)).toEqual([]);
    });
});

