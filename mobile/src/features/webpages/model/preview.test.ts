/**
 * What the in-app preview shows and how it is fenced in: which pages show
 * the server-built draft, the sandboxed wrapper the WebView loads, and where
 * a link may go.
 */

import { decideNavigation, frameDocument, isUnbuilt, originOf, previewSource } from './preview';
import type { Webpage } from './types';

const page = (over: Partial<Webpage> = {}): Webpage =>
    ({
        id: 'wp1',
        framework: 'vanilla',
        runtime: 'light',
        slug: null,
        publicShareId: null,
        htmlSize: 0,
        cssSize: 0,
        jsSize: 0,
        ...over,
    }) as Webpage;

const SERVER = 'https://beeflow.example';

describe('previewSource', () => {
    it('shows the live draft of every light-runtime page, plain HTML or React', () => {
        expect(previewSource(page())).toEqual({ kind: 'draft' });
        expect(previewSource(page({ framework: 'react-mui' }))).toEqual({ kind: 'draft' });
        expect(previewSource(page({ framework: 'react-mui', slug: 'p', publicShareId: 's1' }))).toEqual({ kind: 'draft' });
    });

    it('shows a full-runtime page’s public content while it is public, never the Studio', () => {
        const full = page({ runtime: 'full', slug: 'my page', publicShareId: 's1' });
        expect(previewSource(full)).toEqual({ kind: 'published', path: '/w/my%20page/content' });
    });

    it('says there is no preview for a full-runtime page that is not public', () => {
        expect(previewSource(page({ runtime: 'full', slug: 'old', publicShareId: null }))).toEqual({
            kind: 'unavailable',
            reason: 'full',
        });
    });

    it('knows a page with nothing built yet', () => {
        expect(isUnbuilt(page(), 0)).toBe(true);
        expect(isUnbuilt(page(), 1)).toBe(false);
        expect(isUnbuilt(page({ htmlSize: 10 }), 0)).toBe(false);
    });
});

describe('frameDocument', () => {
    it('wraps the page in the web’s sandbox, with no allow-same-origin and no script of its own', () => {
        const doc = frameDocument({ srcdoc: '<p class="a">"x" & <b>y</b></p>' }, 'mobile');
        expect(doc).toContain('sandbox="allow-scripts allow-forms"');
        expect(doc).not.toContain('allow-same-origin');
        expect(doc).toContain('srcdoc="&lt;p class=&quot;a&quot;&gt;&quot;x&quot; &amp; &lt;b&gt;y&lt;/b&gt;&lt;/p&gt;"');
        expect(doc.replace(/srcdoc="[^"]*"/, '')).not.toMatch(/<script/i);
        expect(doc).toContain('width=device-width');
    });

    it('lays a public address out at desktop width on request', () => {
        const doc = frameDocument({ src: `${SERVER}/w/a/content` }, 'desktop');
        expect(doc).toContain(`src="${SERVER}/w/a/content"`);
        expect(doc).toContain('width=1440');
    });
});

describe('decideNavigation', () => {
    it('loads the wrapper and the public content frame, nothing else', () => {
        expect(decideNavigation('about:blank', true, SERVER)).toBe('load');
        expect(decideNavigation('about:srcdoc', false, SERVER)).toBe('load');
        expect(decideNavigation(`${SERVER}/w/abc/content`, false, SERVER)).toBe('load');
        expect(decideNavigation(`${SERVER}/w/abc/content?v=1`, false, SERVER)).toBe('load');
        expect(decideNavigation(`${SERVER}/`, true, SERVER)).toBe('load');
    });

    it('sends every link that leaves the page to the system browser', () => {
        expect(decideNavigation('https://example.com/', false, SERVER)).toBe('external');
        expect(decideNavigation(`${SERVER}/w/abc/content`, true, SERVER)).toBe('external');
        expect(decideNavigation(`${SERVER}/app/webpages/wp1`, false, SERVER)).toBe('external');
        expect(decideNavigation(`${SERVER}/app/webpages/wp1`, true, SERVER)).toBe('external');
        expect(decideNavigation(`${SERVER}/`, false, SERVER)).toBe('external');
        expect(decideNavigation('mailto:a@b.c', false, SERVER)).toBe('external');
    });

    it('refuses schemes that are not a web or mail address', () => {
        for (const url of ['javascript:alert(1)', 'file:///data/x', 'intent://x#Intent;end', 'data:text/html,x']) {
            expect(decideNavigation(url, true, SERVER)).toBe('block');
        }
    });

    it('reads a server origin', () => {
        expect(originOf('https://Host.example:8443/api/x')).toBe('https://host.example:8443');
        expect(originOf(null)).toBeNull();
        expect(originOf('ftp://x')).toBeNull();
    });
});
