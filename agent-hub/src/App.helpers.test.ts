import { afterEach, describe, expect, it, vi } from 'vitest';
import { blogQuery, readInlinedCms, resolveInitialLocale } from './App.helpers';
import { parseCmsPath } from './utils/cmsPublicRouting';

function visit(path: string) {
    window.history.replaceState(null, '', path);
}

function inline(payload: unknown) {
    const el = document.createElement('script');
    el.id = '__BEEFLOW_CMS__';
    el.type = 'application/json';
    el.textContent = JSON.stringify(payload);
    document.body.appendChild(el);
}

afterEach(() => {
    vi.restoreAllMocks();
    try { localStorage.removeItem('beeflow_locale'); } catch { /* jsdom */ }
    document.getElementById('__BEEFLOW_CMS__')?.remove();
    visit('/');
});

describe('resolveInitialLocale: the path decides the language', () => {
    it('an unprefixed blog post stays in the site default for a Dutch browser', () => {
        vi.spyOn(navigator, 'language', 'get').mockReturnValue('nl-NL');
        visit('/blog/some-post');
        expect(resolveInitialLocale()).toBe('');
    });

    it('an unprefixed page ignores a stored Dutch choice', () => {
        localStorage.setItem('beeflow_locale', 'nl');
        visit('/pricing');
        expect(resolveInitialLocale()).toBe('');
    });

    it('a /nl/ path is Dutch whatever the browser says', () => {
        vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
        visit('/nl/blog/some-post');
        expect(resolveInitialLocale()).toBe('nl');
    });

    it('the legacy ?locale= form still counts until the server redirect lands', () => {
        visit('/pricing?locale=NL');
        expect(resolveInitialLocale()).toBe('nl');
    });

    it('the inlined English payload is used for a Dutch browser on an English URL', () => {
        vi.spyOn(navigator, 'language', 'get').mockReturnValue('nl-NL');
        visit('/blog/some-post');
        inline({ enabled: true, locale: 'en', content: { blog: {} } });
        expect(readInlinedCms(resolveInitialLocale())).not.toBeNull();
    });
});

describe('blogQuery', () => {
    it('asks for the post on a blog post URL', () => {
        const parsed = parseCmsPath('/blog/some-post');
        expect(parsed).not.toBeNull();
        expect(blogQuery(parsed!, new URLSearchParams())).toBe('&blog=post&post=some-post');
    });
});
