// @vitest-environment node
/**
 * The seal of a sealed frame (./seal.ts), in a jsdom window of its own: what the frame's policy
 * cannot stop never reaches the document. Measured against real Chrome by hand (WebRTC to a UDP
 * listener, nested srcdoc frames, <link rel=prerender>, a meta refresh); here the DOM half.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { sealWindow } from './seal';

interface JsdomCtor { new (html: string): { window: Window & typeof globalThis } }
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: JsdomCtor };

function sealed() {
    const { window } = new JSDOM('<!DOCTYPE html><html><head><meta http-equiv="refresh-me" content="x"><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
    sealWindow(window);
    return window;
}

const blockedIn = (doc: Document) => doc.querySelectorAll('iframe,frame,object,embed,link,meta').length;

describe('sealWindow', () => {
    it('takes away the peer connection for good', () => {
        const win = sealed();
        expect((win as unknown as Record<string, unknown>).RTCPeerConnection).toBeUndefined();
        expect(() => Object.defineProperty(win, 'RTCPeerConnection', { value: 1 })).toThrow();
    });

    it('never lets a frame, a link or a meta element into the document, by any insertion method', () => {
        const win = sealed();
        const doc = win.document;
        expect(doc.querySelectorAll('meta')).toHaveLength(0);
        const root = doc.getElementById('root') as HTMLElement;
        root.appendChild(doc.createElement('iframe'));
        root.insertBefore(doc.createElement('link'), null);
        root.append(doc.createElement('object'), 'text');
        const box = doc.createElement('div');
        box.appendChild(doc.createElement('embed'));
        root.appendChild(box);
        root.innerHTML += '<p>kept</p><iframe srcdoc="x"></iframe><svg><foreignObject><link rel="prerender" href="http://x/"></foreignObject></svg>';
        root.insertAdjacentHTML('beforeend', '<meta http-equiv="refresh" content="0;url=http://x/">');
        doc.head.insertAdjacentHTML('afterbegin', '<link rel="prerender" href="http://x/">');
        const child = doc.createElement('span');
        root.appendChild(child);
        child.outerHTML = '<frame src="http://x/"><b>bold</b>';
        expect(blockedIn(doc)).toBe(0);
        expect(root.textContent).toContain('text');
        expect(root.querySelector('p')?.textContent).toBe('kept');
        expect(root.querySelector('b')?.textContent).toBe('bold');
    });

    it('refuses shadow roots, document.write and execCommand', () => {
        const win = sealed();
        const doc = win.document;
        expect(() => doc.createElement('div').attachShadow({ mode: 'open' })).toThrow(/sealed React block/);
        expect(() => doc.write('<iframe></iframe>')).toThrow(/sealed React block/);
        expect(() => doc.execCommand('insertHTML', false, '<iframe></iframe>')).toThrow(/sealed React block/);
    });

    it('keeps a template inert and cleans what is taken out of it', () => {
        const win = sealed();
        const doc = win.document;
        const template = doc.createElement('template');
        template.innerHTML = '<i>x</i><link rel="prerender" href="http://x/">';
        doc.body.appendChild(template.content.cloneNode(true));
        expect(blockedIn(doc)).toBe(0);
        expect(doc.body.querySelector('i')).not.toBeNull();
    });
});
