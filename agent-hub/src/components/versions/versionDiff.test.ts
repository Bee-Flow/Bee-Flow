import { describe, expect, it } from 'vitest';
import { diffVersions, foldUnchanged, normalizeDiff, textOf, type DiffBlock } from './versionDiff';

const block = (op: DiffBlock['op'], text = op): DiffBlock => ({
    op,
    before: op === 'insert' ? null : { type: 'paragraph', content: [{ type: 'text', text }] },
    after: op === 'delete' ? null : { type: 'paragraph', content: [{ type: 'text', text }] },
    words: null,
    formatOnly: false,
});

describe('versionDiff', () => {
    it('reads the diff module’s answer defensively', () => {
        const out = normalizeDiff({
            blocks: [
                { op: 'modify', before: { type: 'paragraph' }, after: { type: 'paragraph' }, words: [{ op: 'insert', text: 'new' }, { op: 'bogus', text: 'x' }, 5] },
                { op: 'unknown' },
                null,
                { op: 'insert', after: 'not a node' },
            ],
            stats: { wordsAdded: 3.4, wordsRemoved: -2, blocksChanged: 'many' },
        });
        expect(out.blocks).toHaveLength(2);
        expect(out.blocks[0].words).toEqual([{ op: 'insert', text: 'new' }]);
        expect(out.blocks[1]).toEqual({ op: 'insert', before: null, after: null, words: null, formatOnly: false });
        expect(out.stats).toEqual({ wordsAdded: 3, wordsRemoved: 0, blocksChanged: 0 });
        expect(out.truncated).toBe(false);
        expect(normalizeDiff(null)).toEqual({ blocks: [], stats: { wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 }, truncated: false });
        expect(normalizeDiff({ blocks: [], stats: { wordsAdded: 9 }, truncated: true }).truncated).toBe(true);
    });

    it('folds unchanged runs, keeping one block of context around each change', () => {
        const blocks = ['equal', 'equal', 'equal', 'modify', 'equal', 'equal', 'equal', 'equal', 'insert', 'equal'].map((op) => block(op as DiffBlock['op']));
        const folded = foldUnchanged(blocks);
        expect(folded.map((e) => (e.kind === 'gap' ? `gap${e.count}` : e.index))).toEqual(['gap2', 2, 3, 4, 'gap2', 7, 8, 9]);
        expect(foldUnchanged(blocks.map(() => block('equal')))).toEqual([{ kind: 'gap', from: 0, to: 9, count: 10 }]);
        expect(foldUnchanged([])).toEqual([]);
    });

    it('reads the text of a node, table rows cell by cell', () => {
        expect(textOf({ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'text', text: 'a' }] }, { type: 'tableCell', content: [{ type: 'text', text: 'b' }] }] })).toBe('a | b');
        expect(textOf(null)).toBe('');
    });

    it('diffs Markdown when both sides have it, HTML otherwise', () => {
        const md = diffVersions({ html: '', markdown: 'One two.' }, { html: '', markdown: 'One two three.' });
        expect(md.blocks.some((b) => b.op !== 'equal')).toBe(true);
        const html = diffVersions({ html: '<p>Same</p>', markdown: null }, { html: '<p>Same</p>', markdown: null });
        expect(html.blocks.every((b) => b.op === 'equal')).toBe(true);
    });
});
