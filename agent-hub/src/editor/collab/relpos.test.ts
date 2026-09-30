/**
 * relpos — editor positions survive concurrent edits when carried as Yjs
 * relative positions, and encoded positions from elsewhere are handled
 * defensively.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { markdownToAst } from '../serialization/mdToAst.js';
import { normalizeLight } from '../engine/normalize.js';
import { astToFragment, fragmentToAst } from './yConvert';
import { syncDocToFragment } from './ySync';
import { relativeFromPos, posFromRelative, encodeRelpos, decodeRelpos, pathOfElement } from './relpos';
import { FRAGMENT_NAME, type AstNode } from './ySchema';

const md = (s: string) => normalizeLight(markdownToAst(s)) as AstNode;

function seeded(markdown: string, clientID = 1): { ydoc: Y.Doc; fragment: Y.XmlFragment } {
    const ydoc = new Y.Doc();
    ydoc.clientID = clientID;
    const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
    astToFragment(md(markdown), fragment);
    return { ydoc, fragment };
}

function copyOf(src: Y.Doc, clientID: number): { ydoc: Y.Doc; fragment: Y.XmlFragment } {
    const ydoc = new Y.Doc();
    ydoc.clientID = clientID;
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(src));
    return { ydoc, fragment: ydoc.getXmlFragment(FRAGMENT_NAME) };
}

const deliver = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));

/** Apply an edit to a document the way the editor would: read, change, sync. */
function editDoc(fragment: Y.XmlFragment, change: (doc: AstNode) => AstNode): void {
    syncDocToFragment(fragment, normalizeLight(change(fragmentToAst(fragment))) as AstNode);
}

const setText = (doc: AstNode, path: number[], text: string): AstNode => {
    const walk = (n: AstNode, rest: number[]): AstNode => {
        if (!rest.length) return { ...n, content: text ? [{ type: 'text', text }] : [] };
        const [i, ...more] = rest;
        return { ...n, content: (n.content || []).map((c, j) => (j === i ? walk(c, more) : c)) };
    };
    return walk(doc, path);
};

describe('relative positions: round trips and concurrent edits', () => {
    it('round-trip every text position of a mixed document', () => {
        const { ydoc, fragment } = seeded('# Title\n\nSome *text* with $x$ math.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | =A2+1 |');
        const doc = fragmentToAst(fragment);
        const paths: number[][] = [];
        const walk = (n: AstNode, p: number[]) => {
            if (['paragraph', 'heading', 'codeBlock'].includes(n.type)) { paths.push(p); return; }
            (n.content || []).forEach((c, i) => walk(c, [...p, i]));
        };
        walk(doc, []);
        expect(paths.length).toBeGreaterThan(6);
        for (const path of paths) {
            let block: AstNode = doc;
            for (const i of path) block = (block.content || [])[i];
            const len = (block.content || []).reduce((n, c) => n + (c.type === 'text' ? (c.text || '').length : 1), 0);
            for (let offset = 0; offset <= len; offset++) {
                const rel = relativeFromPos(fragment, path, offset);
                expect(posFromRelative(fragment, ydoc, rel)).toEqual({ path, offset });
            }
        }
    });

    it('stay on the same character while a co-editor types before them', () => {
        const a = seeded('hello world');
        const b = copyOf(a.ydoc, 2);
        const rel = relativeFromPos(a.fragment, [0], 6); // before "world"
        editDoc(b.fragment, (d) => setText(d, [0], 'oh hello big world'));
        deliver(b.ydoc, a.ydoc);
        expect(posFromRelative(a.fragment, a.ydoc, rel)).toEqual({ path: [0], offset: 13 });
        expect(fragmentToAst(a.fragment).content?.[0].content?.[0].text?.slice(13)).toBe('world');
    });

    it('do not move for edits after them, and follow a block pushed down by a new one above', () => {
        const a = seeded('first\n\nsecond');
        const b = copyOf(a.ydoc, 2);
        const rel = relativeFromPos(a.fragment, [1], 3);
        editDoc(b.fragment, (d) => ({ ...d, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new' }] }, ...(d.content || [])] }));
        editDoc(b.fragment, (d) => setText(d, [2], 'second and more'));
        deliver(b.ydoc, a.ydoc);
        expect(posFromRelative(a.fragment, a.ydoc, rel)).toEqual({ path: [2], offset: 3 });
    });

    it('survive base64 encoding, as awareness and comment anchors carry them', () => {
        const { ydoc, fragment } = seeded('alpha beta');
        const b64 = encodeRelpos(relativeFromPos(fragment, [0], 5) as Y.RelativePosition);
        expect(typeof b64).toBe('string');
        const other = copyOf(ydoc, 3);
        editDoc(other.fragment, (d) => setText(d, [0], 'the alpha beta'));
        expect(posFromRelative(other.fragment, other.ydoc, decodeRelpos(b64))).toEqual({ path: [0], offset: 9 });
    });

});

describe('relative positions: anchors, blocks and misses', () => {
    it('stick to the character before them with a negative assoc (range ends)', () => {
        const { ydoc, fragment } = seeded('ab');
        const end = relativeFromPos(fragment, [0], 1, -1);
        const start = relativeFromPos(fragment, [0], 1, 0);
        editDoc(fragment, (d) => setText(d, [0], 'aXb'));
        expect(posFromRelative(fragment, ydoc, end)).toEqual({ path: [0], offset: 1 });
        expect(posFromRelative(fragment, ydoc, start)).toEqual({ path: [0], offset: 2 });
    });

    it('give block slots for atoms, which follow inserts above them', () => {
        const a = seeded('intro\n\n---\n\noutro');
        const rel = relativeFromPos(a.fragment, [1], 0);
        editDoc(a.fragment, (d) => ({ ...d, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new' }] }, ...(d.content || [])] }));
        expect(posFromRelative(a.fragment, a.ydoc, rel)).toEqual({ path: [2], offset: 0 });
    });

    it('count only what the editor shows: skipped elements and embeds do not shift offsets or paths', () => {
        const ydoc = new Y.Doc();
        const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
        ydoc.transact(() => {
            fragment.insert(0, [new Y.XmlElement('script')]);
            const el = new Y.XmlElement('textblock');
            el.setAttribute('type', 'paragraph');
            const t = new Y.XmlText();
            el.insert(0, [t]);
            fragment.insert(1, [el]);
            t.insert(0, 'ab');
            t.insertEmbed(1, new Y.XmlElement('iframe'), {});
        });
        const rel = relativeFromPos(fragment, [0], 2);
        expect(posFromRelative(fragment, ydoc, rel)).toEqual({ path: [0], offset: 2 });
        const el = fragment.get(1) as Y.XmlElement;
        expect(pathOfElement(fragment, el)).toEqual({ path: [0], type: 'paragraph' });
    });

    it('come back null once their paragraph is deleted, or for paths that do not exist', () => {
        const a = seeded('keep\n\ndrop me');
        const rel = relativeFromPos(a.fragment, [1], 2);
        expect(relativeFromPos(a.fragment, [7], 0)).toBeNull();
        expect(relativeFromPos(a.fragment, [], 0)).toBeNull();
        expect(relativeFromPos(a.fragment, [0, 3], 0)).toBeNull();
        editDoc(a.fragment, (d) => ({ ...d, content: (d.content || []).slice(0, 1) }));
        expect(posFromRelative(a.fragment, a.ydoc, rel)).toBeNull();
        expect(posFromRelative(a.fragment, a.ydoc, null)).toBeNull();
    });

    it('from another document come back null', () => {
        const a = seeded('one');
        const other = seeded('two', 9);
        const rel = relativeFromPos(other.fragment, [0], 1);
        expect(posFromRelative(a.fragment, a.ydoc, rel)).toBeNull();
    });
});

describe('decodeRelpos', () => {
    it('rejects anything that is not an encoded relative position', () => {
        for (const bad of [null, undefined, 42, {}, '', 'not base64!', 'A'.repeat(600), '////', btoa('\u0001\u0002\u0003')]) {
            expect(decodeRelpos(bad)).toBeNull();
        }
    });
});
