/**
 * Comment anchors (capture and re-finding), the outline, the shortcut
 * catalogue and the highlight registry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { markdownToAst } from '../serialization/mdToAst.js';
import { textSelection, pos } from '../engine/selection.js';
import { anchorFromSelection, resolveAnchor, type RelResolver } from './anchors';
import { activeHeadingIndex, collectHeadings, tocItems, tocSignature } from './toc';
import { SHORTCUTS, keyLabel, matchShortcut, type KeyLike } from './shortcuts';
import { clearOwner, paintHighlight, rectsFor, supportsHighlights } from './highlights';

const doc = (md: string) => markdownToAst(md);
const sel = (a: [number[], number], h: [number[], number]) => textSelection(pos(a[0], a[1]), pos(h[0], h[1]));

describe('comment anchors', () => {
    it('captures the quote, its context and the block it starts in', () => {
        const d = doc('Intro line\n\nThe price is ten euros per seat.');
        const a = anchorFromSelection(d, sel([[1], 13], [[1], 16]));
        expect(a).toEqual({ quote: 'ten', prefix: 'Intro line\nThe price is ', suffix: ' euros per seat.', blockIndex: 1 });
    });

    it('has no anchor without a real selection', () => {
        const d = doc('text');
        expect(anchorFromSelection(d, textSelection(pos([0], 1)))).toBeNull();
        expect(anchorFromSelection(d, { type: 'node', path: [0] })).toBeNull();
        expect(anchorFromSelection(doc('a   b'), sel([[0], 1], [[0], 4]))).toBeNull();
    });

    it('finds the quote again after edits, preferring the occurrence with matching context', () => {
        const d = doc('one ten two\n\nthe price is ten euros');
        const a = anchorFromSelection(d, sel([[1], 13], [[1], 16]))!;
        const edited = doc('Added first.\n\none ten two\n\nthe price is ten euros');
        expect(resolveAnchor(edited, a)).toEqual({ from: { path: [2], offset: 13 }, to: { path: [2], offset: 16 } });
    });

    it('reports an anchor whose text is gone', () => {
        const a = anchorFromSelection(doc('keep this'), sel([[0], 5], [[0], 9]))!;
        expect(resolveAnchor(doc('keep that'), a)).toBeNull();
        expect(resolveAnchor(doc('x'), { quote: '', prefix: '', suffix: '', blockIndex: 0 })).toBeNull();
    });

    it('uses relative positions while co-editing, and falls back to the quote when they no longer enclose text', () => {
        const calls: Array<[number, number | undefined]> = [];
        const resolver: RelResolver = {
            toRel: (p, assoc) => { calls.push([p.offset, assoc]); return `r${p.offset}`; },
            fromRel: (b) => (b === 'r0' ? { path: [0], offset: 0 } : b === 'r4' ? { path: [0], offset: 4 } : null),
        };
        const d = doc('abcdef');
        const a = anchorFromSelection(d, sel([[0], 0], [[0], 4]), resolver)!;
        expect(a.relStart).toBe('r0');
        expect(a.relEnd).toBe('r4');
        // The end sticks to the character before it.
        expect(calls).toEqual([[0, undefined], [4, -1]]);
        expect(resolveAnchor(doc('abcdef'), a, resolver)).toEqual({ from: { path: [0], offset: 0 }, to: { path: [0], offset: 4 } });
        const gone: RelResolver = { toRel: () => null, fromRel: () => null };
        expect(resolveAnchor(doc('xx abcd'), a, gone)).toEqual({ from: { path: [0], offset: 3 }, to: { path: [0], offset: 7 } });
    });
});

describe('outline', () => {
    it('lists every heading, nested ones included, in order and with levels', () => {
        const d = doc('# A\n\ntext\n\n> ## B\n\n- ### C\n\n## D');
        const items = tocItems(d);
        expect(items.map((i) => [i.level, i.textContent, i.itemIndex])).toEqual([[1, 'A', 0], [2, 'B', 1], [3, 'C', 2], [2, 'D', 3]]);
        expect(collectHeadings(d)[1].path).toEqual([2, 0]);
    });

    it('marks the heading being read and the ones above it', () => {
        expect(activeHeadingIndex([-50, 20, 400], 100)).toBe(1);
        expect(activeHeadingIndex([200, 400], 100)).toBe(-1);
        const items = tocItems(doc('# A\n\n# B\n\n# C'), 1);
        expect(items.map((i) => [i.isActive, i.isScrolledOver])).toEqual([[false, true], [true, false], [false, false]]);
    });

    it('has a signature that changes only when the outline does', () => {
        const a = tocSignature(tocItems(doc('# A\n\ntext')));
        expect(tocSignature(tocItems(doc('# A\n\nother text')))).toBe(a);
        expect(tocSignature(tocItems(doc('# B\n\ntext')))).not.toBe(a);
    });
});

describe('shortcuts', () => {
    const key = (k: Partial<KeyLike>): KeyLike => ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k });

    it('maps the documented keys to their actions', () => {
        expect(matchShortcut(key({ key: 'k', ctrlKey: true }))).toBe('link');
        expect(matchShortcut(key({ key: 'k', metaKey: true }))).toBe('link');
        expect(matchShortcut(key({ key: 'e', ctrlKey: true }))).toBe('code');
        expect(matchShortcut(key({ key: 'f', ctrlKey: true }))).toBe('find');
        expect(matchShortcut(key({ key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }))).toBe('orderedList');
        expect(matchShortcut(key({ key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true }))).toBe('bulletList');
        expect(matchShortcut(key({ key: '¡', code: 'Digit1', ctrlKey: true, altKey: true }))).toBe('heading1');
        expect(matchShortcut(key({ key: '/', code: 'Slash', ctrlKey: true }))).toBe('shortcuts');
    });

    it('ignores plain typing and AltGr characters', () => {
        expect(matchShortcut(key({ key: 'k' }))).toBeNull();
        expect(matchShortcut(key({ key: 'b', ctrlKey: true }))).toBeNull(); // the engine handles bold
        const altGr = key({ key: '²', code: 'Digit2', ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' });
        expect(matchShortcut(altGr)).toBeNull();
    });

    it('documents every action it handles, with a translation key and English text', () => {
        for (const s of SHORTCUTS) {
            expect(s.labelKey.startsWith('editor.')).toBe(true);
            expect(s.label.length).toBeGreaterThan(0);
            if (s.action) expect(typeof s.match).toBe('function');
        }
        expect(keyLabel('Mod', true)).toBe('⌘');
        expect(keyLabel('Mod', false)).toBe('Ctrl');
        expect(keyLabel('K', false)).toBe('K');
    });
});

describe('highlight registry', () => {
    const g = globalThis as unknown as { CSS?: unknown; Highlight?: unknown };
    const saved = { CSS: g.CSS, Highlight: g.Highlight };
    afterEach(() => { g.CSS = saved.CSS; g.Highlight = saved.Highlight; });

    it('paints the union of every owner\'s ranges under one name, and withdraws them', () => {
        const map = new Map<string, { ranges: Range[] }>();
        g.CSS = { highlights: map };
        g.Highlight = class { ranges: Range[]; constructor(...r: Range[]) { this.ranges = r; } };
        expect(supportsHighlights()).toBe(true);
        const r1 = document.createRange();
        const r2 = document.createRange();
        paintHighlight('bf-test', 'a', [r1]);
        paintHighlight('bf-test', 'b', [r2]);
        expect(map.get('bf-test')!.ranges).toEqual([r1, r2]);
        clearOwner('a');
        expect(map.get('bf-test')!.ranges).toEqual([r2]);
        paintHighlight('bf-test', 'b', []);
        expect(map.has('bf-test')).toBe(false);
    });

    it('falls back to rectangles when the browser has no highlight API', () => {
        g.CSS = undefined;
        expect(supportsHighlights()).toBe(false);
        expect(rectsFor([document.createRange()], null)).toEqual([]);
    });
});
