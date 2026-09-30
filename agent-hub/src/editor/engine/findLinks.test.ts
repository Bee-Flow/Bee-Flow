/**
 * Find and replace in the model, links around the caret, and the text index
 * both are built on.
 */
import { describe, expect, it } from 'vitest';
import { markdownToAst } from '../serialization/mdToAst.js';
import { astToMarkdown } from '../serialization/astToMd.js';
import { createState } from './state.js';
import { textSelection, pos } from './selection.js';
import { buildTextIndex, foldCase, offsetOfPos, posAtOffset, ATOM_CHAR } from './textIndex';
import { cleanQuery, findMatches, matchIndexFrom, replaceMatches } from './find';
import { applyLink, linkRangeAt, normalizeHref, removeLink } from './links';

/* The engine's states are untyped JS objects. */
type AnyState = any;
const doc = (md: string) => markdownToAst(md);
const stateAt = (md: string, anchor: [number[], number], head?: [number[], number]): AnyState => {
    const s = createState(doc(md));
    return { ...s, selection: textSelection(pos(anchor[0], anchor[1]), head ? pos(head[0], head[1]) : undefined) };
};
const md = (s: AnyState) => astToMarkdown(s.doc).trim();

describe('text index', () => {
    it('joins textblocks with newlines and maps offsets both ways, nested blocks included', () => {
        const index = buildTextIndex(doc('# Title\n\n- one\n- two\n\nend'));
        expect(index.text).toBe('Title\none\ntwo\nend');
        expect(posAtOffset(index, 7)).toEqual({ path: [1, 0, 0], offset: 1 });
        expect(offsetOfPos(index, { path: [1, 1, 0], offset: 2 })).toBe(12);
        expect(offsetOfPos(index, { path: [9], offset: 0 })).toBeNull();
    });

    it('counts an inline atom as one placeholder, so offsets stay token offsets', () => {
        const index = buildTextIndex(doc('a $x$ b'));
        expect(index.text).toBe(`a ${ATOM_CHAR} b`);
    });

    it('folds case without changing the length', () => {
        expect(foldCase('AbC')).toBe('abc');
        expect(foldCase('İx').length).toBe(2);
    });
});

describe('find', () => {
    it('finds every occurrence, case-insensitive by default, in document order', () => {
        const matches = findMatches(doc('Cat and cat\n\nA CAT'), 'cat');
        expect(matches.map((m) => [m.from.path[0], m.from.offset, m.to.offset])).toEqual([[0, 0, 3], [0, 8, 11], [1, 2, 5]]);
        expect(findMatches(doc('Cat and cat'), 'cat', { caseSensitive: true })).toHaveLength(1);
    });

    it('never matches across two blocks or finds nothing for an empty query', () => {
        expect(findMatches(doc('ab\n\ncd'), 'b\nc')).toHaveLength(0);
        expect(cleanQuery('b\nc')).toBe('bc');
        expect(findMatches(doc('abc'), '')).toEqual([]);
    });

    it('starts from the first match at or after the caret, wrapping around', () => {
        const matches = findMatches(doc('x x x'), 'x');
        expect(matchIndexFrom(matches, { path: [0], offset: 1 })).toBe(1);
        expect(matchIndexFrom(matches, { path: [0], offset: 5 })).toBe(0);
        expect(matchIndexFrom(matches, null)).toBe(0);
    });

    it('replaces one or all matches and keeps the formatting of the replaced text', () => {
        const s = createState(doc('**old** and old'));
        const matches = findMatches(s.doc, 'old');
        expect(md(replaceMatches(s, [matches[0]], 'new'))).toBe('**new** and old');
        expect(md(replaceMatches(s, matches, 'new'))).toBe('**new** and new');
        expect(replaceMatches(s, [], 'x')).toBe(s);
    });

    it('keeps a replacement on one line', () => {
        const s = createState(doc('a b'));
        expect(md(replaceMatches(s, findMatches(s.doc, 'b'), 'x\ny'))).toBe('a x y');
    });
});

describe('links', () => {
    it('turns what someone typed into a safe address', () => {
        expect(normalizeHref('example.com')).toBe('https://example.com');
        expect(normalizeHref('anna@example.com')).toBe('mailto:anna@example.com');
        expect(normalizeHref('https://x.test/a?b=1')).toBe('https://x.test/a?b=1');
        expect(normalizeHref('/api/storage/f.png')).toBe('/api/storage/f.png');
        expect(normalizeHref('javascript:alert(1)')).toBeNull();
        expect(normalizeHref('data:text/html,<b>')).toBeNull();
        expect(normalizeHref('two words')).toBeNull();
        expect(normalizeHref('')).toBeNull();
    });

    it('links the selection', () => {
        const s = stateAt('see docs here', [[0], 4], [[0], 8]);
        expect(md(applyLink(s, 'https://d.test'))).toBe('see [docs](https://d.test) here');
    });

    it('with only a caret, inserts the address as linked text', () => {
        const s = stateAt('go ', [[0], 3]);
        const next = applyLink(s, 'https://d.test');
        expect(md(next)).toBe('go [https://d.test](https://d.test)');
        expect(next.selection.anchor.offset).toBe(3 + 'https://d.test'.length);
    });

    it('finds, changes and removes the whole link around the caret', () => {
        const s = stateAt('a [link](https://old.test) b', [[0], 4]);
        expect(linkRangeAt(s)).toMatchObject({ from: { offset: 2 }, to: { offset: 6 }, href: 'https://old.test' });
        expect(md(applyLink(s, 'https://new.test'))).toBe('a [link](https://new.test) b');
        expect(md(removeLink(s))).toBe('a link b');
    });

    it('does nothing to remove when the caret is not in a link', () => {
        const s = stateAt('plain', [[0], 2]);
        expect(linkRangeAt(s)).toBeNull();
        expect(removeLink(s)).toBe(s);
    });
});
