/**
 * A shared document is written by other browsers, not by our parsers: every
 * element, attribute and format read from it is untrusted. These tests build
 * hostile content with the raw Yjs API and check what the editor would get.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { fragmentToAst } from './yConvert';
import { FRAGMENT_NAME, MAX_DEPTH, type AstNode } from './ySchema';
import { astToHtml } from '../serialization/astToHtml.js';

function fresh(): { ydoc: Y.Doc; fragment: Y.XmlFragment } {
    const ydoc = new Y.Doc();
    return { ydoc, fragment: ydoc.getXmlFragment(FRAGMENT_NAME) };
}

function textblock(type: unknown, build?: (t: Y.XmlText) => void, attrs: Record<string, unknown> = {}): Y.XmlElement {
    const el = new Y.XmlElement('textblock');
    el.setAttribute('type', type as string);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string);
    const t = new Y.XmlText();
    el.insert(0, [t]);
    if (build) build(t);
    return el;
}

function element(name: string, attrs: Record<string, unknown> = {}, kids: Array<Y.XmlElement | Y.XmlText> = []): Y.XmlElement {
    const el = new Y.XmlElement(name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string);
    if (kids.length) el.insert(0, kids);
    return el;
}

/** Write with the raw API, as a hostile peer would, then read as the editor does. */
function readBack(build: (fragment: Y.XmlFragment) => void): AstNode {
    const { ydoc, fragment } = fresh();
    ydoc.transact(() => build(fragment));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    return fragmentToAst(peer.getXmlFragment(FRAGMENT_NAME));
}

describe('hostile elements', () => {
    it('drops elements that are not part of the schema, and elements in the wrong place', () => {
        const doc = readBack((f) => f.insert(0, [
            element('script', { src: 'https://evil.example/x.js' }),
            element('iframe'),
            new Y.XmlText('loose text at the top level'),
            element('listItem', {}, [textblock('paragraph', (t) => t.insert(0, 'orphan item'))]),
            element('bulletList', {}, [textblock('paragraph', (t) => t.insert(0, 'not an item'))]),
            element('tableRow', {}, [element('tableCell', {}, [textblock('paragraph')])]),
            textblock('paragraph', (t) => t.insert(0, 'kept')),
        ]));
        expect(doc.content?.map((b) => b.type)).toEqual(['bulletList', 'paragraph']);
        // The list had no valid items: it is repaired for display, not trusted.
        expect(doc.content?.[0]).toEqual({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] });
        expect(JSON.stringify(doc)).not.toMatch(/orphan|not an item|loose|evil/);
    });

    it('reads a textblock with an unknown type as a paragraph', () => {
        const doc = readBack((f) => f.insert(0, [textblock('iframe', (t) => t.insert(0, 'hello'))]));
        expect(doc.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]);
    });

});

describe('hostile formats', () => {
    it('sanitises links, colours and fonts in formats', () => {
        const doc = readBack((f) => f.insert(0, [textblock('paragraph', (t) => {
            t.insert(0, 'a', { link: { href: 'javascript:alert(1)' } });
            t.insert(1, 'b', { link: { href: ' JaVaScRiPt:alert(1)', target: 'evil' } });
            t.insert(2, 'c', { link: { href: 'data:text/html,<script>x</script>' } });
            t.insert(3, 'd', { link: { href: 'https://ok.example', target: '_self', rel: 'nofollow "onmouseover=x' } });
            t.insert(4, 'e', { textStyle: { color: 'red;background:url(https://evil.example)', fontFamily: 'x;}body{display:none' } });
            t.insert(5, 'f', { highlight: { color: 'expression(alert(1))' } });
            t.insert(6, 'g', { link: 'https://string-not-object.example' });
            t.insert(7, 'h', { onclick: 'alert(1)', bold: 'yes' });
        })]));
        const inline = doc.content?.[0].content || [];
        // 'e' lost both invalid style values and merges with its plain neighbour.
        expect(inline).toEqual([
            { type: 'text', text: 'abc' },
            { type: 'text', text: 'd', marks: [{ type: 'link', attrs: { href: 'https://ok.example', target: '_self', rel: 'nofollow' } }] },
            { type: 'text', text: 'e' },
            { type: 'text', text: 'f', marks: [{ type: 'highlight' }] },
            { type: 'text', text: 'g' },
            { type: 'text', text: 'h', marks: [{ type: 'bold' }] },
        ]);
        const html = astToHtml(doc);
        expect(html).not.toMatch(/javascript|data:text|url\(|expression|onclick|display:none/i);
    });

    it('keeps code exclusive: code text carries no other formatting', () => {
        const doc = readBack((f) => f.insert(0, [textblock('paragraph', (t) => t.insert(0, 'x', { code: true, bold: true, link: { href: 'https://a.example' } }))]));
        expect(doc.content?.[0].content).toEqual([{ type: 'text', text: 'x', marks: [{ type: 'code' }] }]);
    });

    it('strips formats and non-text embeds inside code blocks, keeping hard breaks as newlines', () => {
        const doc = readBack((f) => f.insert(0, [textblock('codeBlock', (t) => {
            t.insert(0, 'a', { bold: true });
            t.insertEmbed(1, element('hardBreak'), {});
            t.insertEmbed(2, element('formula', { src: '=1' }), {});
            t.insert(3, 'b');
        }, { language: 'js"><script>' })]));
        expect(doc.content).toEqual([{ type: 'codeBlock', content: [{ type: 'text', text: 'a\nb' }] }]);
    });

});

describe('hostile attributes and embeds', () => {
    it('sanitises block attributes and never reads transient ones', () => {
        const doc = readBack((f) => f.insert(0, [
            textblock('heading', (t) => t.insert(0, 'h'), { level: 99, align: 'center" onclick="x', style: 'color:red' }),
            element('image', { src: 'javascript:alert(1)', alt: 'ok', width: '12px', alignment: 'left' }),
            element('image', { src: 'data:image/png;base64,AAAA', width: 320, textWrap: 'true' }),
            element('table', {}, [element('tableRow', {}, [element('tableCell', { colspan: '2" onmouseover="x', header: 'yes', colwidth: 120 }, [
                textblock('paragraph', (t) => t.insertEmbed(0, element('formula', { src: '=1+1', value: '<img src=x onerror=alert(1)>', error: true }), {})),
            ])])]),
            element('orderedList', { start: -5, tight: 'no' }, [element('listItem', {}, [textblock('paragraph', (t) => t.insert(0, 'i'))])]),
        ]));
        const [heading, img1, img2, table, list] = doc.content || [];
        expect(heading).toEqual({ type: 'heading', content: [{ type: 'text', text: 'h' }] });
        expect(img1).toEqual({ type: 'image', attrs: { alt: 'ok', alignment: 'left' } });
        expect(img2).toEqual({ type: 'image', attrs: { src: 'data:image/png;base64,AAAA', width: 320 } });
        expect(table.content?.[0].content?.[0]).toEqual({
            type: 'tableCell', attrs: { colwidth: 120 },
            content: [{ type: 'paragraph', content: [{ type: 'formula', attrs: { src: '=1+1' } }] }],
        });
        expect(list).toEqual({ type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'i' }] }] }] });
    });

    it('keeps a picture a page carries as a data: URL, however long, and drops a script-bearing one', () => {
        // A page embeds its images (up to about 300 KB, 410 KB of base64): no
        // short-attribute cap may cut the address, or the picture is lost for everyone.
        const big = `data:image/jpeg;base64,${'A'.repeat(400 * 1024)}`;
        const doc = readBack((f) => f.insert(0, [
            element('image', { src: big, alt: 'photo' }),
            element('image', { src: 'data:text/html;base64,PHNjcmlwdD4=', alt: 'x' }),
        ]));
        const [img1, img2] = doc.content || [];
        expect(img1).toEqual({ type: 'image', attrs: { src: big, alt: 'photo' } });
        expect(img2).toEqual({ type: 'image', attrs: { alt: 'x' } });
        expect(astToHtml(doc)).toContain('src="data:image/jpeg;base64,');
    });

    it('ignores embeds that are not inline atoms, and plain JSON embeds', () => {
        const doc = readBack((f) => f.insert(0, [textblock('paragraph', (t) => {
            t.insert(0, 'a');
            t.insertEmbed(1, element('script', { src: 'x' }), {});
            t.insertEmbed(2, { image: 'https://evil.example/x.png' }, {});
            t.insertEmbed(3, element('mathInline', { latex: 'x^2' }), {});
            t.insert(4, 'b');
        })]));
        expect(doc.content?.[0].content).toEqual([
            { type: 'text', text: 'a' }, { type: 'mathInline', attrs: { latex: 'x^2' } }, { type: 'text', text: 'b' },
        ]);
    });

});

describe('hostile structure', () => {
    it('repairs containers that concurrent edits (or a peer) left empty, without writing anything', () => {
        const { ydoc, fragment } = fresh();
        ydoc.transact(() => fragment.insert(0, [
            element('taskList', {}, [element('taskItem', { checked: true })]),
            element('table'),
            element('blockquote'),
            textblock('paragraph', (t) => t.insert(0, 'x')),
        ]));
        const before = Y.encodeStateVector(ydoc);
        const doc = fragmentToAst(fragment);
        expect(doc.content?.map((b) => b.type)).toEqual(['taskList', 'table', 'blockquote', 'paragraph']);
        expect(doc.content?.[0].content?.[0]).toEqual({ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [] }] });
        expect(doc.content?.[1].content?.[0].content?.[0].content).toEqual([{ type: 'paragraph', content: [] }]);
        expect(Y.encodeStateVector(ydoc)).toEqual(before);
    });

    it('stops at a maximum nesting depth instead of recursing without bound', () => {
        const doc = readBack((f) => {
            let inner: Y.XmlElement = textblock('paragraph', (t) => t.insert(0, 'deep'));
            for (let i = 0; i < MAX_DEPTH + 20; i++) inner = element('blockquote', {}, [inner]);
            f.insert(0, [inner]);
        });
        let depth = 0;
        let n: AstNode | undefined = doc.content?.[0];
        while (n && n.type === 'blockquote') { depth++; n = n.content?.[0]; }
        expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
        expect(JSON.stringify(doc)).not.toContain('deep');
    });

    it('reads only the first text of a textblock', () => {
        const doc = readBack((f) => {
            const el = textblock('paragraph', (t) => t.insert(0, 'first'));
            el.insert(1, [new Y.XmlText('second'), element('script')]);
            f.insert(0, [el]);
        });
        expect(doc.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }]);
    });
});
