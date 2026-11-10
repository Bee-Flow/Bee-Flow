import { afterEach, describe, expect, it } from 'vitest';
import { startFrameSync } from './deviceFrameSync';

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function frameDocument(): Document {
    return document.implementation.createHTMLDocument('frame');
}

function addStyle(text: string): HTMLStyleElement {
    const el = document.createElement('style');
    el.textContent = text;
    document.head.appendChild(el);
    return el;
}

const copies = (doc: Document) => Array.from(doc.head.querySelectorAll('[data-device-frame-style]'));

afterEach(() => {
    document.head.querySelectorAll('style, link').forEach((el) => el.remove());
    document.documentElement.removeAttribute('data-theme');
    document.body.removeAttribute('class');
    document.body.removeAttribute('style');
});

describe('startFrameSync', () => {
    it('copies every stylesheet of the host, in order', () => {
        addStyle('.a { color: red; }');
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/assets/app.css';
        document.head.appendChild(link);
        const frame = frameDocument();
        const stop = startFrameSync(document, frame);
        const found = copies(frame);
        expect(found.map((el) => el.tagName)).toEqual(['STYLE', 'LINK']);
        expect(found[0].textContent).toBe('.a { color: red; }');
        expect(found[1].getAttribute('href')).toBe('/assets/app.css');
        stop();
        expect(copies(frame)).toHaveLength(0);
    });

    it('follows stylesheets added, changed and removed later', async () => {
        const first = addStyle('.a { color: red; }');
        const frame = frameDocument();
        const stop = startFrameSync(document, frame);
        const second = addStyle('.b { color: blue; }');
        await flush();
        expect(copies(frame).map((el) => el.textContent)).toEqual(['.a { color: red; }', '.b { color: blue; }']);
        first.textContent = '.a { color: green; }';
        await flush();
        expect(copies(frame)[0].textContent).toBe('.a { color: green; }');
        second.remove();
        await flush();
        expect(copies(frame).map((el) => el.textContent)).toEqual(['.a { color: green; }']);
        stop();
    });

    it('inserts a sheet added in the middle at the same place', async () => {
        const first = addStyle('.a {}');
        addStyle('.c {}');
        const frame = frameDocument();
        const stop = startFrameSync(document, frame);
        const middle = document.createElement('style');
        middle.textContent = '.b {}';
        first.after(middle);
        await flush();
        expect(copies(frame).map((el) => el.textContent)).toEqual(['.a {}', '.b {}', '.c {}']);
        stop();
    });

    it('leaves the frame’s own head content alone', () => {
        const frame = frameDocument();
        const own = frame.createElement('meta');
        own.setAttribute('name', 'viewport');
        frame.head.appendChild(own);
        addStyle('.a {}');
        const stop = startFrameSync(document, frame);
        stop();
        expect(frame.head.querySelector('meta[name="viewport"]')).not.toBeNull();
    });

    it('mirrors the theme attributes on <html> and the class on <body>, not the body style', async () => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.className = 'theme-body';
        document.body.style.overflow = 'hidden';
        const frame = frameDocument();
        const stop = startFrameSync(document, frame);
        expect(frame.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(frame.body.className).toBe('theme-body');
        expect(frame.body.getAttribute('style')).toBeNull();
        document.documentElement.setAttribute('data-theme', 'light');
        await flush();
        expect(frame.documentElement.getAttribute('data-theme')).toBe('light');
        document.documentElement.removeAttribute('data-theme');
        await flush();
        expect(frame.documentElement.hasAttribute('data-theme')).toBe(false);
        stop();
    });
});
