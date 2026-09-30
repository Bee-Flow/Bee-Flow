/**
 * yConvert — every document the editor can hold survives a trip through a
 * shared fragment unchanged (apart from what is never stored: formula results
 * and the trailing paragraph normalizeLight adds), and nothing is stored that
 * should not be.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { markdownToAst } from '../serialization/mdToAst.js';
import { htmlToAst } from '../serialization/htmlToAst.js';
import { normalizeLight } from '../engine/normalize.js';
import { astToFragment, fragmentToAst, createYCache, sameInY } from './yConvert';
import { FRAGMENT_NAME, type AstNode } from './ySchema';

const MD_CORPUS = [
    '# Heading one',
    '## Heading two',
    '### Heading three',
    'A simple paragraph.',
    'Text with **bold**, *italic*, ~~strike~~ and `code`.',
    'Combined ***bold italic*** word.',
    'A [link](https://example.com) here.',
    'See [the page](<https://en.wikipedia.org/wiki/Foo_(bar)>) here.',
    'Highlight ==this== please.',
    'Color [red]{color=#ef4444} text.',
    'Font [serif]{font=Georgia} text.',
    'Underline [under]{u} text.',
    '- one\n- two\n- three',
    '1. first\n2. second\n3. third',
    '3. starts at three\n4. next',
    '- [ ] todo\n- [x] done',
    '- parent\n  - child\n    - grandchild',
    '> a quote',
    '> line one\n>\n> line two',
    '```js\nconst x = 1;\n```',
    '```\nplain\n\ncode\n```',
    '```mermaid\ngraph TD; A-->B\n```',
    '$$\nE = mc^2\n$$',
    'Inline $E=mc^2$ math.',
    '![Alt](https://x.com/a.png)',
    '![Chart](https://x.com/c.png){w=400 align=left wrap}',
    '---',
    'Before\n\n---',
    '| Name | Age |\n| :-- | --: |\n| Alice | 30 |\n| Bob | 25 |',
    '| A | B |\n| --- | --- |\n| 1 | =A2+10 |\n| 2 | =SUM(A2:A3) |\n',
    '```chart\n{"type":"bar","title":"Sales","labels":["Q1","Q2"],"series":[{"name":"2026","data":[1,2]}]}\n```',
    '# Centered {align=center}',
    'Some text {align=center}',
    'Line one  \nline two after a hard break.',
    'Emoji 👩‍💻 and accents: café, naïve — “quotes”.',
    '',
];

const HTML_CORPUS = [
    '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">x</a></p>',
    '<table><tbody><tr><td><ul><li>one</li><li>two</li></ul></td></tr></tbody></table>',
    '<table><tbody><tr><td><img src="https://e.com/a.png" alt="pic"></td></tr></tbody></table>',
    '<table><tbody><tr><td><blockquote><p>quoted</p></blockquote></td></tr></tbody></table>',
    '<table><tbody><tr><th colspan="2">H1+H2</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>',
    '<table><tbody><tr><td rowspan="3">tall</td><td>x</td></tr></tbody></table>',
    '<h2 style="text-align:right">Title</h2><p>Text <strong>bold <em>both</em></strong> <mark style="background-color: #fde68a">hl</mark></p>',
    '<p><span style="color: #2563eb; font-family: Georgia">styled</span> and <u>under</u><br>after break</p>',
    '<div data-type="mermaid-diagram" data-code="Z3JhcGggVEQ7IEEtLT5C"></div><p>after</p>',
    '<p>inline <span data-type="inlineMath" data-latex="a^2">\\(a^2\\)</span> math</p>',
    '<img src="https://e.com/b.png" data-width="320" data-alignment="right" data-text-wrap="true">',
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li></ul>',
    '<pre class="notebook-code-block"><code class="language-python">print("hi")</code></pre>',
];

/** What is never stored: formula results, and the paragraph normalizeLight appends. */
function stored(doc: AstNode): AstNode {
    const strip = (n: AstNode): AstNode => {
        const out: AstNode = { ...n };
        if (n.type === 'formula' && n.attrs) {
            const { value: _v, error: _e, ...rest } = n.attrs;
            if (Object.keys(rest).length) out.attrs = rest; else delete out.attrs;
        }
        if (n.content) out.content = n.content.map(strip);
        return out;
    };
    const content = (doc.content || []).map(strip);
    const last = content[content.length - 1];
    const prev = content[content.length - 2];
    const trailing = last && last.type === 'paragraph' && !last.attrs && !(last.content || []).length;
    const atomBefore = prev && ['horizontalRule', 'image', 'mermaid', 'mathBlock', 'chart'].includes(prev.type);
    if (trailing && (content.length === 1 || atomBefore)) content.pop();
    return { type: 'doc', content };
}

function throughY(ast: AstNode): { read: AstNode; ydoc: Y.Doc } {
    const ydoc = new Y.Doc();
    astToFragment(ast, ydoc.getXmlFragment(FRAGMENT_NAME));
    // A second document that only ever saw the update: what a co-editor reads.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    return { read: fragmentToAst(peer.getXmlFragment(FRAGMENT_NAME)), ydoc: peer };
}

describe('round-trip through a shared fragment', () => {
    for (const md of MD_CORPUS) {
        it(`keeps Markdown ${JSON.stringify(md.slice(0, 40))}`, () => {
            const ast = normalizeLight(markdownToAst(md)) as AstNode;
            const { read } = throughY(ast);
            expect(read).toEqual(stored(ast));
            expect(normalizeLight(read)).toEqual(ast);
        });
    }
    for (const html of HTML_CORPUS) {
        it(`keeps HTML ${JSON.stringify(html.slice(0, 40))}`, () => {
            const ast = normalizeLight(htmlToAst(html)) as AstNode;
            const { read } = throughY(ast);
            expect(read).toEqual(stored(ast));
            expect(normalizeLight(read)).toEqual(ast);
        });
    }

    it('keeps a long mixed document, and reads it back as the same objects from the cache', () => {
        const md = MD_CORPUS.filter(Boolean).join('\n\n');
        const ast = normalizeLight(markdownToAst(md)) as AstNode;
        const { ydoc } = throughY(ast);
        const cache = createYCache();
        const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
        const first = fragmentToAst(fragment, cache);
        expect(first).toEqual(stored(ast));
        const second = fragmentToAst(fragment, cache);
        second.content?.forEach((block, i) => expect(block).toBe(first.content?.[i]));
        cache.destroy();
    });

    it('never stores formula results', () => {
        const ast = normalizeLight(markdownToAst('| A | B |\n| --- | --- |\n| 1 | =A2+1 |')) as AstNode;
        const ydoc = new Y.Doc();
        const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
        astToFragment(ast, fragment);
        expect(fragment.toString()).toContain('=A2+1');
        expect(fragment.toString()).not.toMatch(/value=|error=/);
    });

    it('does not store the empty paragraph normalizeLight appends after an atom or in an empty document', () => {
        for (const md of ['---', '']) {
            const ydoc = new Y.Doc();
            const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
            astToFragment(normalizeLight(markdownToAst(md)) as AstNode, fragment);
            expect(fragment.toArray().filter((c) => c instanceof Y.XmlElement && c.nodeName === 'textblock')).toHaveLength(0);
        }
    });

    it('stores a textblock as one element with one text and the type as an attribute', () => {
        const ydoc = new Y.Doc();
        const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
        astToFragment(markdownToAst('## Title **bold**') as AstNode, fragment);
        const el = fragment.get(0) as Y.XmlElement;
        expect(el.nodeName).toBe('textblock');
        expect(el.getAttributes()).toEqual({ type: 'heading', level: 2 });
        expect(el.length).toBe(1);
        expect((el.get(0) as Y.XmlText).toDelta()).toEqual([{ insert: 'Title ' }, { insert: 'bold', attributes: { bold: true } }]);
    });
});

describe('sameInY', () => {
    it('ignores how runs are split, formula results and default attributes', () => {
        const a: AstNode = { type: 'paragraph', content: [{ type: 'text', text: 'ab' }, { type: 'formula', attrs: { src: '=1', value: '1', error: false } }] };
        const b: AstNode = { type: 'paragraph', attrs: { align: null }, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'formula', attrs: { src: '=1' } }] };
        expect(sameInY(a, b)).toBe(true);
    });

    it('sees text, formatting, type and attribute changes', () => {
        const base: AstNode = { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'x' }] };
        expect(sameInY(base, { ...base, content: [{ type: 'text', text: 'y' }] })).toBe(false);
        expect(sameInY(base, { ...base, content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }] })).toBe(false);
        expect(sameInY(base, { ...base, type: 'paragraph' })).toBe(false);
        expect(sameInY(base, { ...base, attrs: { level: 3 } })).toBe(false);
    });
});
