/**
 * editor/diff — block + word compare of two document versions.
 */
import { describe, it, expect } from 'vitest';
import { markdownToAst } from '../serialization/mdToAst.js';
import { diffDocs, diffHtml, diffMarkdown, type DiffBlock } from './index';
import { diffWords, blockTokens } from './words';
import type { AstNode } from '../collab/ySchema';

const md = (s: string) => markdownToAst(s) as AstNode;
const changed = (blocks: DiffBlock[]) => blocks.filter((b) => b.op !== 'equal');
const text = (n: AstNode | undefined): string => (!n ? '' : typeof n.text === 'string' ? n.text : (n.content || []).map(text).join('|'));

describe('diffDocs: paragraphs and headings', () => {
    it('finds nothing between identical documents', () => {
        const doc = md('# Title\n\nOne paragraph.\n\n- a\n- b\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
        const d = diffDocs(doc, md('# Title\n\nOne paragraph.\n\n- a\n- b\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'));
        expect(changed(d.blocks)).toEqual([]);
        expect(d.stats).toEqual({ wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 });
        expect(d.truncated).toBeUndefined();
    });

    it('shows a changed sentence word by word', () => {
        const d = diffDocs(md('Intro.\n\nThe quick brown fox jumps.\n\nOutro.'), md('Intro.\n\nThe slow red fox jumps high.\n\nOutro.'));
        const [mod] = changed(d.blocks);
        expect(mod.op).toBe('modify');
        expect(mod.formatOnly).toBe(false);
        expect(mod.words).toEqual([
            { op: 'equal', text: 'The ' },
            { op: 'delete', text: 'quick brown' },
            { op: 'insert', text: 'slow red' },
            { op: 'equal', text: ' fox jumps' },
            { op: 'insert', text: ' high' },
            { op: 'equal', text: '.' },
        ]);
        expect(d.stats).toEqual({ wordsAdded: 3, wordsRemoved: 2, blocksChanged: 1 });
        expect(d.blocks.map((b) => b.op)).toEqual(['equal', 'modify', 'equal']);
    });

    it('reports added and removed paragraphs whole', () => {
        const d = diffDocs(md('Keep this.\n\nRemove this one.'), md('Keep this.\n\nA brand new paragraph here.'));
        expect(changed(d.blocks).map((b) => b.op)).toEqual(['delete', 'insert']);
        expect(text(changed(d.blocks)[0].before)).toBe('Remove this one.');
        expect(changed(d.blocks)[0].after).toBeUndefined();
        expect(d.stats).toEqual({ wordsAdded: 5, wordsRemoved: 3, blocksChanged: 2 });
    });

    it('calls a bolded word, a heading level or a retype a formatting change', () => {
        for (const [from, to] of [['Make this bold.', 'Make **this** bold.'], ['# Title', '## Title'], ['Title', '# Title']]) {
            const [mod] = changed(diffDocs(md(from), md(to)).blocks);
            expect(mod.op).toBe('modify');
            expect(mod.formatOnly).toBe(true);
            expect(mod.words?.every((w) => w.op === 'equal')).toBe(true);
        }
        expect(diffDocs(md('# Title'), md('## Title')).stats).toEqual({ wordsAdded: 0, wordsRemoved: 0, blocksChanged: 1 });
    });

    it('ignores blank lines and formula results', () => {
        const d = diffDocs(md('One.\n\n\n\nTwo.'), md('One.\n\nTwo.'));
        expect(changed(d.blocks)).toEqual([]);
        const withValue: AstNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'formula', attrs: { src: '=1+1', value: '2' } }] }] };
        const without: AstNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'formula', attrs: { src: '=1+1' } }] }] };
        expect(changed(diffDocs(withValue, without).blocks)).toEqual([]);
    });

    it('accepts missing or malformed documents', () => {
        expect(diffDocs(null, undefined)).toEqual({ blocks: [], stats: { wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 } });
        const d = diffDocs(null, md('Hello there'));
        expect(d.blocks.map((b) => b.op)).toEqual(['insert']);
        expect(d.stats.wordsAdded).toBe(2);
        expect(() => diffDocs({ type: 'doc', content: [null as unknown as AstNode, { type: 'bogus' }] }, md('x'))).not.toThrow();
    });
});

describe('diffDocs: lists', () => {
    it('shows an added item inside its list, and keeps the rest of the list together', () => {
        const d = diffDocs(md('- one\n- two\n- three'), md('- one\n- two\n- inserted\n- three'));
        expect(d.blocks.map((b) => b.op)).toEqual(['equal', 'insert', 'equal']);
        const [eq, ins] = d.blocks;
        expect(eq.after?.type).toBe('bulletList');
        expect(eq.after?.content?.map(text)).toEqual(['one', 'two']);
        expect(eq.before?.content?.map(text)).toEqual(['one', 'two']);
        expect(ins.after).toEqual({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inserted' }] }] }] });
        expect(d.stats).toEqual({ wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 });
    });

    it('keeps ordered-list numbering for a cut-down list', () => {
        const d = diffDocs(md('1. one\n2. two\n3. three'), md('1. one\n2. two\n3. three changed'));
        const mod = changed(d.blocks)[0];
        expect(mod.after?.type).toBe('orderedList');
        expect(mod.after?.attrs?.start).toBe(3);
    });

    it('reports ticking a task and moving a paragraph into a list as formatting changes', () => {
        const [tick] = changed(diffDocs(md('- [ ] ship it'), md('- [x] ship it')).blocks);
        expect(tick).toMatchObject({ op: 'modify', formatOnly: true });
        const [wrap] = changed(diffDocs(md('buy milk'), md('- buy milk')).blocks);
        expect(wrap).toMatchObject({ op: 'modify', formatOnly: true });
        expect(wrap.after?.type).toBe('bulletList');
    });
});

describe('diffDocs: tables', () => {
    const before = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';

    it('narrows a change down to the cell, word by word', () => {
        const d = diffDocs(md(before), md('| Name | Age |\n| --- | --- |\n| Alice | 31 |\n| Bob | 25 |'));
        expect(d.blocks.map((b) => b.op)).toEqual(['equal', 'modify', 'equal']);
        const mod = d.blocks[1];
        expect(mod.before?.type).toBe('table');
        expect(text(mod.before)).toBe('30');
        expect(text(mod.after)).toBe('31');
        expect(d.stats).toEqual({ wordsAdded: 1, wordsRemoved: 1, blocksChanged: 1 });
        // The unchanged cells render as (parts of) the table.
        expect(text(d.blocks[0].after)).toBe('Name|Age|Alice');
        expect(text(d.blocks[2].after)).toBe('Bob|25');
    });

    it('shows an added row as inserted cells', () => {
        const d = diffDocs(md(before), md(`${before}\n| Carol | 41 |`));
        expect(changed(d.blocks).map((b) => [b.op, text(b.after)])).toEqual([['insert', 'Carol|41']]);
        expect(d.stats.blocksChanged).toBe(2);
    });

    it('keeps empty cells so the table still shows them', () => {
        const d = diffDocs(md('| A |  |\n| --- | --- |\n| 1 | 2 |'), md('| A |  |\n| --- | --- |\n| 1 | 3 |'));
        expect(d.blocks[0].after?.content?.[0].content?.length).toBe(2);
    });

    it('compares formulas by their source', () => {
        const d = diffDocs(md('| A | B |\n| --- | --- |\n| 1 | =A2+1 |'), md('| A | B |\n| --- | --- |\n| 1 | =A2+2 |'));
        const mod = changed(d.blocks)[0];
        expect(mod.op).toBe('modify');
        expect(mod.words).toEqual([{ op: 'delete', text: '=A2+1' }, { op: 'insert', text: '=A2+2' }]);
    });
});

describe('diffDocs: atoms', () => {
    const img = (attrs: Record<string, unknown>): AstNode => ({ type: 'doc', content: [{ type: 'image', attrs: { src: 'https://e.example/a.png', ...attrs } }] });

    it('calls a resized image a formatting change and a new image a change', () => {
        expect(changed(diffDocs(img({}), img({ width: 300 })).blocks)[0]).toMatchObject({ op: 'modify', formatOnly: true });
        expect(changed(diffDocs(img({}), img({ src: 'https://e.example/b.png' })).blocks)[0]).toMatchObject({ op: 'modify', formatOnly: false });
    });

    it('sees a changed diagram', () => {
        const d = diffDocs(md('```mermaid\ngraph TD; A-->B\n```'), md('```mermaid\ngraph TD; A-->C\n```'));
        expect(changed(d.blocks)).toHaveLength(1);
        expect(changed(d.blocks)[0].op).toBe('modify');
    });
});

describe('diffMarkdown / diffHtml', () => {
    it('parse and compare', () => {
        expect(diffMarkdown('Hello world', 'Hello there world').stats).toEqual({ wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 });
        const d = diffHtml('<h2>Plan</h2><p>Ship <strong>on</strong> Monday</p>', '<h2>Plan</h2><p>Ship on Tuesday</p>');
        expect(d.stats).toEqual({ wordsAdded: 1, wordsRemoved: 1, blocksChanged: 1 });
        expect(changed(d.blocks)[0].words).toEqual([
            { op: 'equal', text: 'Ship on ' }, { op: 'delete', text: 'Monday' }, { op: 'insert', text: 'Tuesday' },
        ]);
        expect(diffHtml('', '').blocks).toEqual([]);
    });
});

describe('bounded work', () => {
    const big = (n: number, edit?: (i: number) => string | null) =>
        Array.from({ length: n }, (_, i) => (edit && edit(i) !== null ? edit(i) : `Paragraph number ${i} of the document.`)).join('\n\n');

    it('falls back to statistics only above the block limit', () => {
        const d = diffMarkdown(big(2100), big(2100, (i) => (i % 100 === 0 ? `Paragraph number ${i} was rewritten.` : null)));
        expect(d.truncated).toBe(true);
        expect(d.blocks).toEqual([]);
        expect(d.stats).toEqual({ wordsAdded: 42, wordsRemoved: 63, blocksChanged: 21 });
        expect(diffMarkdown('a\n\nb\n\nc', 'a\n\nb\n\nd', { maxBlocks: 2 }).truncated).toBe(true);
    });

    it('compares a large document with scattered edits quickly', () => {
        const a = md(big(1900));
        const b = md(big(1900, (i) => (i % 50 === 7 ? `Paragraph number ${i} of the edited document.` : i % 97 === 3 ? '' : null)));
        const t0 = Date.now();
        const d = diffDocs(a, b);
        expect(Date.now() - t0).toBeLessThan(3000);
        expect(d.truncated).toBeUndefined();
        expect(d.stats.blocksChanged).toBe(38 + 20);
        expect(d.blocks.filter((x) => x.op === 'modify')).toHaveLength(38);
    });

    it('survives a complete rewrite', () => {
        const d = diffMarkdown(big(800), Array.from({ length: 800 }, (_, i) => `Totally different line ${i * 7}`).join('\n\n'));
        expect(d.stats.blocksChanged).toBeGreaterThan(0);
        expect(d.blocks.length).toBeGreaterThan(0);
    });
});

describe('diffWords', () => {
    it('keeps spaces inside the runs so the text reads back exactly', () => {
        const a = blockTokens(md('alpha beta gamma').content?.[0] as AstNode);
        const b = blockTokens(md('alpha gamma delta').content?.[0] as AstNode);
        const wd = diffWords(a, b);
        expect(wd.words.filter((w) => w.op !== 'insert').map((w) => w.text).join('')).toBe('alpha beta gamma');
        expect(wd.words.filter((w) => w.op !== 'delete').map((w) => w.text).join('')).toBe('alpha gamma delta');
        expect([wd.added, wd.removed]).toEqual([1, 1]);
    });
});
