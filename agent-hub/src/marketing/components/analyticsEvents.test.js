import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startAnalyticsEvents, safeHref, trackFormSuccess } from './analyticsEvents';

let stop;
let tracked;

function mountHtml(html) {
    document.body.innerHTML = html;
}

function click(selector) {
    const el = document.querySelector(selector);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return el;
}

describe('analyticsEvents', () => {
    beforeEach(() => {
        tracked = [];
        window.umami = { track: (name, data) => tracked.push({ name, data }) };
        window.history.replaceState(null, '', '/');
        stop = startAnalyticsEvents();
    });

    afterEach(() => {
        stop?.();
        delete window.umami;
        document.body.innerHTML = '';
    });

    it('no-ops when the tracker is absent (no consent → window.umami undefined)', () => {
        delete window.umami;
        mountHtml('<button>Sign up</button>');
        expect(() => click('button')).not.toThrow();
        expect(tracked).toEqual([]);
    });

    it('tracks a CTA button click with its label', () => {
        mountHtml('<a class="btn btn-primary" href="/contact">Plan a call</a>');
        click('a');
        expect(tracked).toHaveLength(1);
        expect(tracked[0].name).toBe('cta_click');
        expect(tracked[0].data.label).toBe('Plan a call');
    });

    // Tabs, accordions, carousel arrows and the cookie banner are page
    // controls. Counting them put cta_click above the number of visits.
    it('does not count page controls as calls to action', () => {
        mountHtml('<section data-cms-block-id="blk_faq" data-cms-block-type="faq"><button>What does it cost?</button></section><button>Accept</button>');
        click('section button');
        click('body > button');
        expect(tracked).toEqual([]);
    });

    // Attribute names must match what marketing/ProductWebsite.jsx actually
    // renders on the block wrapper — data-cms-block-id/-type, not data-block-*.
    it('attaches the CMS block id and type when present', () => {
        mountHtml('<section data-cms-block-id="blk_1" data-cms-block-type="hero"><a href="/pricing">See pricing</a></section>');
        click('a');
        expect(tracked[0]).toMatchObject({
            name: 'cta_click',
            data: { label: 'See pricing', block: 'blk_1', blockType: 'hero' },
        });
    });

    it('tracks outbound links with the destination host', () => {
        mountHtml('<a href="https://github.com/example/repo">GitHub</a>');
        click('a');
        expect(tracked[0].name).toBe('outbound_click');
        expect(tracked[0].data.host).toBe('github.com');
    });

    it('tracks downloads with the file extension', () => {
        mountHtml('<a href="/files/whitepaper.PDF">Download</a>');
        click('a');
        expect(tracked[0].name).toBe('file_download');
        expect(tracked[0].data.ext).toBe('pdf');
    });

    it('tracks form submissions by form identity, never contents', () => {
        mountHtml('<form name="contact"><input name="email" value="me@example.com" /></form>');
        document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(tracked[0].name).toBe('form_submit');
        expect(tracked[0].data).toEqual({ form: 'contact' });
        expect(JSON.stringify(tracked)).not.toContain('me@example.com');
    });

    // Privacy guarantee: query strings routinely carry tokens, emails and
    // campaign identifiers. Nothing after ? or # may ever be sent.
    it('strips query strings and fragments from every href', () => {
        expect(safeHref('https://x.example/a/b?token=secret#frag')).toBe('https://x.example/a/b');
        mountHtml('<a href="https://other.example/p?email=me@example.com">Go</a>');
        click('a');
        const blob = JSON.stringify(tracked);
        expect(blob).not.toContain('me@example.com');
        expect(blob).not.toContain('?');
    });

    it('ignores plain internal navigation outside a block', () => {
        mountHtml('<a href="/about">About</a>');
        click('a');
        expect(tracked).toEqual([]);   // already counted as a pageview
    });

    it('ignores anchor and javascript: links', () => {
        mountHtml('<a href="#section">Jump</a>');
        click('a');
        expect(tracked.filter(t => t.name !== 'cta_click')).toEqual([]);
    });

    it('counts a form as started once, on the first focus in a real field', () => {
        mountHtml('<form aria-label="Plan a call"><input name="ref_code_2" tabindex="-1"><input name="name"><input name="email"></form>');
        const focus = (sel) => document.querySelector(sel).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        focus('[name="ref_code_2"]');
        expect(tracked).toEqual([]);
        focus('[name="name"]');
        focus('[name="email"]');
        expect(tracked).toEqual([{ name: 'form_start', data: { form: 'Plan a call' } }]);
    });

    it('sends form_success with the form name and block, nothing else', () => {
        trackFormSuccess('Plan a call', 'blk_form');
        expect(tracked).toEqual([{ name: 'form_success', data: { form: 'Plan a call', block: 'blk_form', blockType: 'form' } }]);
    });

    it('never calls identify()', () => {
        const identify = vi.fn();
        window.umami.identify = identify;
        mountHtml('<button>Go</button>');
        click('button');
        expect(identify).not.toHaveBeenCalled();
    });

    it('survives a throwing tracker without breaking the page', () => {
        window.umami.track = () => { throw new Error('boom'); };
        mountHtml('<button>Go</button>');
        expect(() => click('button')).not.toThrow();
    });

    it('stops tracking after cleanup', () => {
        stop();
        mountHtml('<button>Go</button>');
        click('button');
        expect(tracked).toEqual([]);
    });
});
