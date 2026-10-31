// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lineDiff, lineDiffStats, splitLines } from './lineDiff';

const kinds = (rows: ReturnType<typeof lineDiff>) => rows.map((r) => r.kind);

describe('splitLines', () => {
    it('reads every kind of line end and ignores the final one', () => {
        expect(splitLines('a\r\nb\rc\nd\n')).toEqual(['a', 'b', 'c', 'd']);
        expect(splitLines('')).toEqual([]);
        expect(splitLines(null)).toEqual([]);
        expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
    });
});

describe('lineDiff', () => {
    it('folds a text that did not change into one gap', () => {
        const rows = lineDiff('a\nb\nc', 'a\nb\nc');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'gap', hidden: 3 });
        expect(lineDiff('a\nb\nc', 'a\nb\nc', { context: Infinity }).map((r) => r.kind)).toEqual(['same', 'same', 'same']);
    });

    it('marks lines that were only added, with their new numbers', () => {
        const rows = lineDiff('a\nb', 'a\nx\ny\nb', { context: Infinity });
        expect(kinds(rows)).toEqual(['same', 'add', 'add', 'same']);
        expect(rows[1]).toMatchObject({ oldNo: null, newNo: 2, text: 'x' });
        expect(rows[3]).toMatchObject({ oldNo: 2, newNo: 4, text: 'b' });
        expect(lineDiffStats(rows)).toEqual({ added: 2, removed: 0 });
    });

    it('marks lines that were only deleted, with their old numbers', () => {
        const rows = lineDiff('a\nx\ny\nb', 'a\nb', { context: Infinity });
        expect(kinds(rows)).toEqual(['same', 'del', 'del', 'same']);
        expect(rows[1]).toMatchObject({ oldNo: 2, newNo: null, text: 'x' });
        expect(lineDiffStats(rows)).toEqual({ added: 0, removed: 2 });
    });

    it('shows an edited line as a deletion followed by an addition', () => {
        const rows = lineDiff('const a = 1;\nreturn a;', 'const a = 2;\nreturn a;', { context: Infinity });
        expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual(['del:const a = 1;', 'add:const a = 2;', 'same:return a;']);
    });

    it('handles a mixed edit', () => {
        const before = ['one', 'two', 'three', 'four', 'five'].join('\n');
        const after = ['one', 'TWO', 'three', 'five', 'six'].join('\n');
        const rows = lineDiff(before, after, { context: Infinity });
        expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
            'same:one', 'del:two', 'add:TWO', 'same:three', 'del:four', 'same:five', 'add:six',
        ]);
    });

    it('keeps three lines around a change and folds the rest', () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        const changed = [...lines];
        changed[14] = 'changed';
        const rows = lineDiff(lines.join('\n'), changed.join('\n'));
        expect(kinds(rows)).toEqual(['gap', 'same', 'same', 'same', 'del', 'add', 'same', 'same', 'same', 'gap']);
        expect(rows[0]).toMatchObject({ hidden: 11 });
        expect(rows[0].hiddenRows?.[0]).toMatchObject({ oldNo: 1, text: 'line 1' });
        expect(rows[9]).toMatchObject({ hidden: 12 });
    });

    it('does not fold a single unchanged line', () => {
        const rows = lineDiff('a\nb\nc\nd\ne\nf\ng\nh\ni', 'X\nb\nc\nd\ne\nf\ng\nh\nY', { context: 3 });
        // b..i are 7 unchanged lines between two changes; the first three and the last three stay, one is left over.
        expect(rows.some((r) => r.kind === 'gap')).toBe(false);
    });

    it('reads CRLF text the same as LF text', () => {
        expect(lineDiff('a\r\nb\r\n', 'a\nb\n')[0]).toMatchObject({ kind: 'gap', hidden: 2 });
        const rows = lineDiff('a\r\nb', 'a\nc', { context: Infinity });
        expect(kinds(rows)).toEqual(['same', 'del', 'add']);
    });

    it('treats a missing side as empty', () => {
        expect(kinds(lineDiff(null, 'a\nb', { context: Infinity }))).toEqual(['add', 'add']);
        expect(kinds(lineDiff('a', null, { context: Infinity }))).toEqual(['del']);
        expect(lineDiff(null, null)).toEqual([]);
    });

    it('past the cost bound shows the middle as one replaced block', () => {
        const a = Array.from({ length: 40 }, (_, i) => `a${i}`).join('\n');
        const b = Array.from({ length: 40 }, (_, i) => `b${i}`).join('\n');
        const rows = lineDiff(a, b, { context: Infinity, maxCost: 3 });
        expect(lineDiffStats(rows)).toEqual({ added: 40, removed: 40 });
        expect(kinds(rows).slice(0, 40).every((k) => k === 'del')).toBe(true);
    });
});
