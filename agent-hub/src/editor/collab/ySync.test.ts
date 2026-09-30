/**
 * ySync — local edits become the smallest Yjs changes, and edits the local
 * editor has not seen yet are never undone by them.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { markdownToAst } from '../serialization/mdToAst.js';
import { normalizeLight } from '../engine/normalize.js';
import { astToFragment, createYCache, fragmentToAst, type YCache } from './yConvert';
import { syncDocToFragment } from './ySync';
import { FRAGMENT_NAME, type AstNode } from './ySchema';

const LOCAL = Symbol('local');
const md = (s: string) => normalizeLight(markdownToAst(s)) as AstNode;
const p = (...content: AstNode[]): AstNode => ({ type: 'paragraph', content });
const t = (text: string, marks?: AstNode['marks']): AstNode => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const doc = (...content: AstNode[]): AstNode => ({ type: 'doc', content });

interface Peer { ydoc: Y.Doc; fragment: Y.XmlFragment; cache: YCache; view: AstNode }

/** A co-editor: a Y.Doc, its cache, and the document its editor shows. */
function peer(clientID: number, from?: Y.Doc): Peer {
    const ydoc = new Y.Doc();
    ydoc.clientID = clientID;
    if (from) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(from));
    const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
    const cache = createYCache();
    return { ydoc, fragment, cache, view: normalizeLight(fragmentToAst(fragment, cache)) as AstNode };
}

function seed(markdown: string): Y.Doc {
    const ydoc = new Y.Doc();
    ydoc.clientID = 1;
    astToFragment(md(markdown), ydoc.getXmlFragment(FRAGMENT_NAME));
    return ydoc;
}

/** What the editor does after a local transform: sync inside a local transaction. */
function edit(pr: Peer, next: AstNode): void {
    const n = normalizeLight(next) as AstNode;
    pr.ydoc.transact(() => syncDocToFragment(pr.fragment, n, pr.cache), LOCAL);
    pr.view = n;
}

function reread(pr: Peer): void {
    pr.view = normalizeLight(fragmentToAst(pr.fragment, pr.cache)) as AstNode;
}

function exchange(a: Peer, b: Peer): void {
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
}

const text = (pr: Peer) => (fragmentToAst(pr.fragment).content || []).map((b) => JSON.stringify(b));
const setBlock = (d: AstNode, i: number, b: AstNode): AstNode => ({ ...d, content: (d.content || []).map((x, j) => (j === i ? b : x)) });

/** Record the Yjs events one sync produces. */
function eventsOf(pr: Peer, fn: () => void): Array<Y.YEvent<Y.AbstractType<unknown>>> {
    const seen: Array<Y.YEvent<Y.AbstractType<unknown>>> = [];
    const h = (evs: Array<Y.YEvent<Y.AbstractType<unknown>>>) => seen.push(...evs);
    pr.fragment.observeDeep(h);
    fn();
    pr.fragment.unobserveDeep(h);
    return seen;
}

describe('minimal changes', () => {
    it('writes nothing when the document did not change (also after normalisation copies)', () => {
        const a = peer(2, seed('# Title\n\nSome **text**.\n\n| A | =1+1 |\n| --- | --- |\n| x | y |\n\n---'));
        let updates = 0;
        a.ydoc.on('update', () => updates++);
        edit(a, a.view);
        edit(a, JSON.parse(JSON.stringify(a.view)));
        expect(updates).toBe(0);
    });

    it('turns typing one character into one text insert', () => {
        const a = peer(2, seed('first paragraph\n\nsecond paragraph'));
        const next = setBlock(a.view, 1, p(t('second! paragraph')));
        const events = eventsOf(a, () => edit(a, next));
        expect(events).toHaveLength(1);
        expect(events[0].target).toBeInstanceOf(Y.XmlText);
        expect((events[0] as Y.YTextEvent).delta).toEqual([{ retain: 6 }, { insert: '!' }]);
    });

    it('turns bolding a word into a format change', () => {
        const a = peer(2, seed('make this bold'));
        const next = setBlock(a.view, 0, p(t('make '), t('this', [{ type: 'bold' }]), t(' bold')));
        const events = eventsOf(a, () => edit(a, next));
        expect(events).toHaveLength(1);
        expect((events[0] as Y.YTextEvent).delta).toEqual([{ retain: 5 }, { retain: 4, attributes: { bold: true } }]);
    });

    it('retypes a paragraph as an attribute change on the same element', () => {
        const a = peer(2, seed('title to be'));
        const el = a.fragment.get(0);
        const events = eventsOf(a, () => edit(a, setBlock(a.view, 0, { type: 'heading', attrs: { level: 2 }, content: [t('title to be')] })));
        expect(a.fragment.get(0)).toBe(el);
        expect(events).toHaveLength(1);
        expect([...(events[0] as Y.YXmlEvent).attributesChanged].sort()).toEqual(['level', 'type']);
    });

    it('changes a formula in place (its embedded element keeps its identity)', () => {
        const a = peer(2, seed('| A | B |\n| --- | --- |\n| 1 | =A2+1 |'));
        const cellPath = (d: AstNode) => d.content?.[0].content?.[1].content?.[1].content?.[0] as AstNode;
        const child = (el: Y.XmlFragment | Y.XmlElement, i: number) => el.get(i) as Y.XmlElement;
        const cellParagraph = child(child(child(child(a.fragment, 0), 1), 1), 0);
        const text0 = cellParagraph.get(0) as Y.XmlText;
        const embed = text0.toDelta()[0].insert;
        const table = a.view.content?.[0] as AstNode;
        const row = table.content?.[1] as AstNode;
        const cell = row.content?.[1] as AstNode;
        const para = cellPath(a.view);
        const nextCell = { ...cell, content: [{ ...para, content: [{ type: 'formula', attrs: { src: '=A2+2' } }] }] };
        const next = setBlock(a.view, 0, { ...table, content: [table.content?.[0] as AstNode, { ...row, content: [row.content?.[0] as AstNode, nextCell] }] });
        edit(a, next);
        expect(text0.toDelta()[0].insert).toBe(embed);
        expect((embed as Y.XmlElement).getAttribute('src')).toBe('=A2+2');
    });

    it('keeps unchanged blocks as the same elements when the whole document is replaced without a cache', () => {
        const ydoc = seed('# A\n\none\n\ntwo\n\nthree');
        const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
        const before = fragment.toArray();
        syncDocToFragment(fragment, md('# A\n\none\n\nTWO changed\n\nthree\n\nfour'));
        const after = fragment.toArray();
        expect(after[0]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
        expect(after[2]).toBe(before[2]);
        expect(after[3]).toBe(before[3]);
        expect(fragmentToAst(fragment)).toEqual(md('# A\n\none\n\nTWO changed\n\nthree\n\nfour'));
    });

    it('pairs a split paragraph with the half that keeps its text', () => {
        const a = peer(2, seed('hello world'));
        const el = a.fragment.get(0);
        edit(a, doc(p(), p(t('hello world'))));
        expect(a.fragment.get(1)).toBe(el);
        expect(a.fragment.length).toBe(2);
    });
});

describe('never undoing what the local editor has not seen', () => {
    it('merges concurrent typing in the same paragraph', () => {
        const a = peer(2, seed('abc'));
        const b = peer(3, a.ydoc);
        edit(a, doc(p(t('Xabc'))));
        edit(b, doc(p(t('abcY'))));
        exchange(a, b);
        reread(a);
        reread(b);
        expect(a.view).toEqual(b.view);
        expect(a.view.content?.[0]).toEqual(p(t('XabcY')));
    });

    it('keeps text a co-editor typed while the local editor was behind (same paragraph)', () => {
        const a = peer(2, seed('hello world'));
        const b = peer(3, a.ydoc);
        edit(b, doc(p(t('hello brave world'))));
        exchange(a, b); // a received it, but its editor has not re-read yet (e.g. mid-composition)
        edit(a, doc(p(t('hello world!'))));
        exchange(a, b);
        reread(a);
        reread(b);
        expect(a.view.content?.[0]).toEqual(p(t('hello brave world!')));
        expect(b.view).toEqual(a.view);
    });

    it('keeps a paragraph a co-editor inserted, and does not resurrect one they deleted', () => {
        const a = peer(2, seed('one\n\ntwo\n\nthree'));
        const b = peer(3, a.ydoc);
        edit(b, doc(p(t('one')), p(t('inserted')), p(t('three'))));
        exchange(a, b);
        edit(a, doc(p(t('one edited')), p(t('two')), p(t('three'))));
        exchange(a, b);
        reread(a);
        reread(b);
        expect(a.view.content).toEqual([p(t('one edited')), p(t('inserted')), p(t('three'))]);
        expect(b.view).toEqual(a.view);
    });

    it('does not store the trailing paragraph twice when two peers end on an atom', () => {
        const a = peer(2, seed('intro\n\n---'));
        const b = peer(3, a.ydoc);
        edit(a, setBlock(a.view, 0, p(t('intro A'))));
        edit(b, setBlock(b.view, 0, p(t('intro B'))));
        exchange(a, b);
        reread(a);
        expect(a.fragment.length).toBe(2);
        expect(a.view.content?.map((x) => x.type)).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
    });

    it('stores the trailing paragraph once someone types in it', () => {
        const a = peer(2, seed('---'));
        edit(a, doc({ type: 'horizontalRule' }, p(t('typed'))));
        expect(text(a)).toEqual([JSON.stringify({ type: 'horizontalRule' }), JSON.stringify(p(t('typed')))]);
    });
});
