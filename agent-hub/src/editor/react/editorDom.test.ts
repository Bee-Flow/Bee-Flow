import { describe, it, expect, afterEach } from 'vitest';
import { selectionText, selectionRect, blockRect } from './editorDom';

describe('editor DOM selection helpers', () => {
    afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.innerHTML = ''; });

    it('selectionText reads the DOM selection only for a text selection', () => {
        document.body.innerHTML = '<p id="p">hello world</p>';
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('p')!);
        window.getSelection()!.addRange(range);
        expect(selectionText({ state: { selection: { type: 'text' } } })).toBe('hello world');
        expect(selectionText({ state: { selection: { type: 'node' } } })).toBe('');
        expect(selectionText(null)).toBe('');
    });

    it('selectionRect is null without a selection or with an empty box', () => {
        expect(selectionRect()).toBeNull();
        document.body.innerHTML = '<p id="p">x</p>';
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('p')!);
        window.getSelection()!.addRange(range);
        // jsdom has no layout: every box is 0×0 at the origin.
        expect(selectionRect()).toBeNull();
    });

    it('blockRect anchors on the current block, the host, or a fixed corner', () => {
        const host = document.createElement('div');
        host.getBoundingClientRect = () => ({ top: 50, left: 10, bottom: 400 }) as DOMRect;
        const block = document.createElement('p');
        block.getBoundingClientRect = () => ({ top: 80, left: 20, bottom: 100 }) as DOMRect;
        const node = {};
        const domForNode = new Map([[node, block]]);
        expect(blockRect({ host, domForNode, currentBlock: () => node })).toEqual({ top: 80, left: 20, bottom: 100 });
        expect(blockRect({ host, domForNode, currentBlock: () => null })).toEqual({ top: 50, left: 10, bottom: 74 });
        expect(blockRect({})).toEqual({ top: 120, left: 120, bottom: 144 });
    });
});
