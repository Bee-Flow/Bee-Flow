import { describe, expect, it } from 'vitest';
import { extractSections, parseFrameMessage, resolveParts, type MergePart } from './canvasBridge';
import { slideAt } from './editor/useDeckDraft';
import { shortcutOf } from './editor/useEditorShortcuts';

describe('parseFrameMessage: what the frame may say', () => {
    it('reads each bridge message into its kind', () => {
        expect(parseFrameMessage({ __beeflowDocReady: true })).toEqual({ kind: 'ready' });
        expect(parseFrameMessage({ __beeflowDocDirty: true, html: '<p>x</p>', requestId: 'r1' })).toEqual({ kind: 'dirty', html: '<p>x</p>', requestId: 'r1' });
        expect(parseFrameMessage({ __beeflowDocCaret: true, sectionId: 'pricing' })).toEqual({ kind: 'caret', sectionId: 'pricing' });
        expect(parseFrameMessage({ __beeflowDocOutline: true, items: [{ index: 0, level: 9, text: 'Intro', sectionId: null }] }))
            .toEqual({ kind: 'outline', items: [{ index: 0, level: 3, text: 'Intro', sectionId: null }] });
        expect(parseFrameMessage({ __beeflowDocStats: true, words: 12, pages: 0, text: 'a b' })).toEqual({ kind: 'stats', stats: { words: 12, pages: 1, text: 'a b' } });
        expect(parseFrameMessage({ __beeflowDocKey: true, key: 'save' })).toEqual({ kind: 'key', key: 'save' });
        expect(parseFrameMessage({ __beeflowDocPatched: true, applied: ['a', 3], missing: ['b'] })).toEqual({ kind: 'patched', applied: ['a'], missing: ['b'] });
    });

    it('takes a selection as a comment anchor, with only the anchor fields', () => {
        const m = parseFrameMessage({ __beeflowDocSelection: true, anchor: { quote: 'Price', prefix: 'The ', suffix: ' is', blockIndex: 2.7, sectionId: 'pricing', evil: 'x' } });
        expect(m).toEqual({ kind: 'selection', anchor: { quote: 'Price', prefix: 'The ', suffix: ' is', blockIndex: 2, sectionId: 'pricing' } });
        expect(parseFrameMessage({ __beeflowDocSelection: true, anchor: { quote: '' } })).toEqual({ kind: 'selection', anchor: null });
    });

    it('ignores anything else, including a shortcut it does not know and a body without html', () => {
        expect(parseFrameMessage(null)).toBeNull();
        expect(parseFrameMessage('hello')).toBeNull();
        expect(parseFrameMessage({ __beeflowDocKey: true, key: 'delete-everything' })).toBeNull();
        expect(parseFrameMessage({ __beeflowDocDirty: true, html: 42 })).toBeNull();
        expect(parseFrameMessage({ somethingElse: true })).toBeNull();
    });
});

describe('extractSections and resolveParts', () => {
    it('takes the named sections out of a composed preview, without running anything', () => {
        const html = '<!DOCTYPE html><html><head><script>window.bad=1</script></head><body><section data-doc-section="a"><p>A</p></section><section data-doc-section="b"><p>B</p></section></body></html>';
        expect(extractSections(html, ['b', 'missing'])).toEqual({ b: '<p>B</p>' });
        expect(extractSections(html, [])).toEqual({});
        expect((window as unknown as { bad?: number }).bad).toBeUndefined();
    });

    it('joins the parts with the side chosen per conflict, mine when not chosen', () => {
        const parts: MergePart[] = [
            { kind: 'clean', html: '<h1>T</h1>' },
            { kind: 'conflict', key: 'k1', label: 'Pricing', base: '<p>b</p>', mine: '<p>m</p>', theirs: '<p>t</p>' },
            { kind: 'conflict', key: 'k2', label: 'Terms', base: '', mine: '<p>m2</p>', theirs: '<p>t2</p>' },
        ];
        expect(resolveParts(parts, { k1: 'theirs' })).toBe('<h1>T</h1><p>t</p><p>m2</p>');
    });
});

describe('slideAt: the slide the outline caret is on', () => {
    const outline = '# Deck\n\n## One\n- a\n\n## Two\n- b\n';
    it('counts the cover as slide 0, then one per "## "', () => {
        expect(slideAt(outline, 3)).toBe(0);
        expect(slideAt(outline, outline.indexOf('- a'))).toBe(1);
        expect(slideAt(outline, outline.length)).toBe(2);
    });
    it('without a cover, the first heading is slide 0', () => {
        expect(slideAt('## One\n\n## Two\n', 14)).toBe(1);
        expect(slideAt('intro\n## One', 2)).toBe(0);
    });
});

describe('shortcutOf', () => {
    const k = (key: string, extra: Partial<KeyboardEvent> = {}) => shortcutOf({ key, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, ...extra });
    it('knows the editor shortcuts with Ctrl or ⌘', () => {
        expect(k('s')).toBe('save');
        expect(k('f')).toBe('find');
        expect(k('H', { shiftKey: true })).toBe('history');
        expect(k('m', { altKey: true })).toBe('comment');
        expect(k('/')).toBe('help');
        expect(shortcutOf({ key: 's', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe('save');
    });
    it('leaves every other key alone', () => {
        expect(shortcutOf({ key: 's', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBeNull();
        expect(k('s', { shiftKey: true })).toBeNull();
        expect(k('b')).toBeNull();
    });
});
