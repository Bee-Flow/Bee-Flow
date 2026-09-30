/**
 * Two editors, two Y.Docs, one relay: the binding under concurrent editing.
 *
 * The relay queues updates until `exchange()`, so both sides really edit
 * concurrently (neither has seen the other's change) before they converge —
 * the situation a network produces, not the lock-step a synchronous relay
 * would. Every test ends with both editors AND both shared documents equal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { EditorView } from '../engine/view.js';
import { createState } from '../engine/state.js';
import { textSelection, pos } from '../engine/selection.js';
import * as T from '../engine/transforms.js';
import * as Tbl from '../engine/tables.js';
import { markdownToAst } from '../serialization/mdToAst.js';
import { astToFragment } from './yConvert';
import { bindEditor, type CollabBinding } from './binding';
import { rebaseDoc } from './rebaseDoc';

const RELAY = { relay: true };

interface Side { ydoc: Y.Doc; view: any; host: HTMLElement; binding: CollabBinding }

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((f) => f()); cleanups = []; });

function pair(md: string) {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const toB: Uint8Array[] = [];
    const toA: Uint8Array[] = [];
    a.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== RELAY) toB.push(u); });
    b.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== RELAY) toA.push(u); });
    astToFragment(markdownToAst(md), a.getXmlFragment('content'));
    const exchange = () => {
        while (toB.length || toA.length) {
            const forB = toB.splice(0);
            const forA = toA.splice(0);
            if (forB.length) b.transact(() => forB.forEach((u) => Y.applyUpdate(b, u, RELAY)), RELAY);
            if (forA.length) a.transact(() => forA.forEach((u) => Y.applyUpdate(a, u, RELAY)), RELAY);
        }
    };
    exchange();
    const side = (ydoc: Y.Doc): Side => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const view = new EditorView(host, { state: createState(markdownToAst('')) });
        const binding = bindEditor(view, { ydoc, fragment: ydoc.getXmlFragment('content') });
        cleanups.push(() => { view.destroy(); host.remove(); ydoc.destroy(); });
        return { ydoc, view, host, binding };
    };
    return { A: side(a), B: side(b), exchange };
}

const md = (s: Side) => s.view.getMarkdown().trim();
const caret = (s: Side, path: number[], offset: number, head?: [number[], number]) => {
    s.view.setSelection(textSelection(pos(path, offset), head ? pos(head[0], head[1]) : pos(path, offset)));
};
const type = (s: Side, text: string) => { for (const ch of text) s.view.dispatch((st: any) => T.insertText(st, ch), { kind: 'type' }); };

function expectConverged(A: Side, B: Side) {
    expect(md(A)).toBe(md(B));
    expect(A.ydoc.getXmlFragment('content').toJSON()).toBe(B.ydoc.getXmlFragment('content').toJSON());
    // The screen shows the model on both sides.
    expect(A.host.textContent).toBe(B.host.textContent);
}

describe('loading', () => {
    it('shows what the shared document holds, on both sides', () => {
        const { A, B } = pair('# Title\n\nFirst paragraph');
        expect(md(A)).toBe('# Title\n\nFirst paragraph');
        expect(md(B)).toBe(md(A));
        expect(A.host.querySelector('h1')?.textContent).toBe('Title');
    });
});

describe('concurrent editing converges', () => {
    it('interleaved typing in the same paragraph keeps both people\'s words', () => {
        const { A, B, exchange } = pair('hello world');
        caret(A, [0], 0);
        caret(B, [0], 11);
        type(A, 'Oh, ');
        type(B, '!');
        exchange();
        expectConverged(A, B);
        expect(md(A)).toBe('Oh, hello world!');
        type(A, 'x');
        exchange();
        type(B, 'y');
        exchange();
        expectConverged(A, B);
    });

    it('a split and a keystroke in the same paragraph both survive', () => {
        const { A, B, exchange } = pair('abcdef');
        caret(A, [0], 3);
        A.view.dispatch(T.splitBlock, { kind: 'structural' });
        caret(B, [0], 6);
        type(B, 'Z');
        exchange();
        expectConverged(A, B);
        expect(md(A)).toContain('abc');
        expect(md(A)).toContain('Z');
    });

    it('a merge (backspace at a paragraph start) converges with typing elsewhere', () => {
        const { A, B, exchange } = pair('one\n\ntwo\n\nthree');
        caret(A, [1], 0);
        A.view.dispatch(T.deleteBackward, { kind: 'delete' });
        caret(B, [2], 5);
        type(B, '!');
        exchange();
        expectConverged(A, B);
        expect(md(A)).toBe('onetwo\n\nthree!');
    });

    it('turning a paragraph into a list while someone types in the next one', () => {
        const { A, B, exchange } = pair('item\n\nnext');
        caret(A, [0], 2);
        A.view.dispatch((s: any) => T.toggleList(s, 'bulletList'), { kind: 'structural' });
        caret(B, [1], 4);
        type(B, ' line');
        exchange();
        expectConverged(A, B);
        expect(md(A)).toBe('- item\n\nnext line');
    });

    it('a heading retype keeps a co-editor\'s concurrent typing in that block', () => {
        const { A, B, exchange } = pair('Title');
        caret(A, [0], 0);
        A.view.dispatch((s: any) => T.toggleBlockType(s, 'heading', { level: 2 }), { kind: 'structural' });
        caret(B, [0], 5);
        type(B, 's');
        exchange();
        expectConverged(A, B);
        expect(md(A)).toBe('## Titles');
    });

    it('adding a table row while someone types in a cell', () => {
        const { A, B, exchange } = pair('| a | b |\n| --- | --- |\n| 1 | 2 |');
        const tableRows = () => A.view.state.doc.content[0].content.length;
        const rowsBefore = tableRows();
        caret(A, [0, 1, 0, 0], 1);
        A.view.dispatch(Tbl.addRowAfter, { kind: 'structural' });
        caret(B, [0, 1, 1, 0], 1);
        type(B, '0');
        exchange();
        expectConverged(A, B);
        expect(tableRows()).toBe(rowsBefore + 1);
        expect(md(B)).toContain('20');
    });
});

describe('undo is per person', () => {
    it('undoes only my own typing, not what someone else wrote meanwhile', () => {
        const { A, B, exchange } = pair('base');
        caret(A, [0], 4);
        type(A, ' mine');
        exchange();
        caret(B, [0], 0);
        type(B, 'theirs ');
        exchange();
        expect(md(A)).toBe('theirs base mine');
        A.view.undo();
        exchange();
        expectConverged(A, B);
        expect(md(A)).toBe('theirs base');
        A.view.redo();
        exchange();
        expect(md(B)).toBe('theirs base mine');
    });

    it('groups a run of typing into one step but keeps a format change separate', () => {
        const { A } = pair('abc');
        caret(A, [0], 0, [[0], 3]);
        A.view.dispatch((s: any) => T.toggleMark(s, 'bold'), { kind: 'format' });
        caret(A, [0], 3);
        type(A, 'xyz');
        // Typing after bold text continues in bold.
        expect(md(A)).toBe('**abcxyz**');
        expect(A.view.can().undo()).toBe(true);
        A.view.undo();
        expect(md(A)).toBe('**abc**');
        A.view.undo();
        expect(md(A)).toBe('abc');
        expect(A.view.can().undo()).toBe(false);
    });

    it('puts the caret back where it was before the undone change', () => {
        const { A } = pair('hello');
        caret(A, [0], 5);
        type(A, ' world');
        A.view.undo();
        expect(A.view.state.selection.anchor).toEqual({ path: [0], offset: 5 });
    });
});

describe('the caret survives other people\'s edits', () => {
    it('moves along when text is inserted before it in the same paragraph', () => {
        const { A, B, exchange } = pair('hello world');
        caret(B, [0], 6, [[0], 11]);
        caret(A, [0], 0);
        type(A, '>> ');
        exchange();
        expect(B.view.state.selection.anchor).toEqual({ path: [0], offset: 9 });
        expect(B.view.state.selection.head).toEqual({ path: [0], offset: 14 });
    });

    it('follows its paragraph when a block is inserted above it', () => {
        const { A, B, exchange } = pair('first\n\nsecond');
        caret(B, [1], 3);
        caret(A, [0], 5);
        A.view.dispatch(T.splitBlock, { kind: 'structural' });
        type(A, 'inserted');
        exchange();
        expect(B.view.state.selection.anchor).toEqual({ path: [2], offset: 3 });
        expect(md(B)).toBe('first\n\ninserted\n\nsecond');
    });
});

describe('composition (IME)', () => {
    const composition = (host: HTMLElement, typeName: string, data = '') => {
        let e: Event;
        try { e = new CompositionEvent(typeName, { data, bubbles: true }); } catch {
            e = new Event(typeName, { bubbles: true });
            Object.defineProperty(e, 'data', { value: data });
        }
        host.dispatchEvent(e);
    };

    it('holds a remote edit back while composing and applies both at compositionend', () => {
        const { A, B, exchange } = pair('abc');
        B.view.focus();
        caret(B, [0], 3);
        B.view.writeSelection();
        composition(B.host, 'compositionstart');
        expect(B.view.composing).toBe(true);
        caret(A, [0], 0);
        type(A, 'X');
        exchange();
        // Nothing touched the composing editor.
        expect(md(B)).toBe('abc');
        composition(B.host, 'compositionend', 'ね');
        expect(md(B)).toBe('Xabcね');
        exchange();
        expectConverged(A, B);
    });
});

describe('external content', () => {
    it('setDoc while bound is an ordinary, undoable edit that syncs', () => {
        const { A, B, exchange } = pair('old text');
        A.view.setDoc(markdownToAst('# New\n\nbody'));
        exchange();
        expectConverged(A, B);
        expect(md(B)).toBe('# New\n\nbody');
        A.view.undo();
        exchange();
        expect(md(B)).toBe('old text');
    });

    it('never writes the editor\'s own normalisation (trailing paragraph after a rule)', () => {
        const { A, B, exchange } = pair('text\n\n---');
        // Both editors show a caret paragraph after the rule; the shared doc has none.
        expect(A.view.state.doc.content.at(-1).type).toBe('paragraph');
        caret(A, [0], 4);
        type(A, '1');
        caret(B, [0], 0);
        type(B, '2');
        exchange();
        expectConverged(A, B);
        const kids = A.ydoc.getXmlFragment('content').toArray();
        expect((kids.at(-1) as Y.XmlElement).nodeName).toBe('horizontalRule');
    });
});

describe('a whole-document rewrite made from an older snapshot', () => {
    it('keeps what a co-editor wrote after the snapshot (an AI fill that took a while)', () => {
        const { A, B, exchange } = pair('Intro {{name}}\n\nSecond');
        // A takes the snapshot the rewrite is made from…
        const snapshot = A.view.getMarkdown().trim();
        const base = markdownToAst(snapshot);
        // …B adds a paragraph while the rewrite is being made…
        caret(B, [1], 6);
        B.view.dispatch(T.splitBlock, { kind: 'structural' });
        type(B, 'B wrote this');
        exchange();
        expect(md(A)).toContain('B wrote this');
        // …and the rewrite lands on A.
        const filled = markdownToAst(snapshot.replace('{{name}}', 'Alice'));
        A.view.replaceDoc(filled, { rebase: (current: any, next: any) => rebaseDoc(base, current, next) });
        exchange();
        expectConverged(A, B);
        expect(md(A)).toBe('Intro Alice\n\nSecond\n\nB wrote this');
        // One undo step on A takes back the rewrite only.
        A.view.undo();
        exchange();
        expect(md(B)).toBe('Intro {{name}}\n\nSecond\n\nB wrote this');
    });

    it('keeps a co-editor\'s words inside the very paragraph the rewrite changes', () => {
        const { A, B, exchange } = pair('Dear {{name}}, welcome.');
        const base = markdownToAst(A.view.getMarkdown().trim());
        caret(B, [0], 23);
        type(B, ' See you soon.');
        exchange();
        A.view.replaceDoc(markdownToAst('Dear Alice, welcome.'), { rebase: (current: any, next: any) => rebaseDoc(base, current, next) });
        exchange();
        expectConverged(A, B);
        expect(md(A)).toBe('Dear Alice, welcome. See you soon.');
    });
});

describe('a local change that cannot be shared', () => {
    it('shows the shared document, not the rejected edit, on screen and in the model', () => {
        const { A } = pair('hello\n\nsecond');
        const errors: unknown[] = [];
        const binding = A.binding as any;
        binding.opts.onError = (e: unknown) => errors.push(e);
        const transact = A.ydoc.transact.bind(A.ydoc);
        (A.ydoc as any).transact = (fn: (tr: Y.Transaction) => void, origin?: unknown) => {
            if (origin === A.binding.origin) throw new Error('refused');
            return transact(fn, origin);
        };
        caret(A, [0], 5);
        type(A, 'X');
        expect(errors).toHaveLength(1);
        expect(md(A)).toBe('hello\n\nsecond');
        expect(A.host.textContent).toBe('hellosecond');
        (A.ydoc as any).transact = transact;
        caret(A, [0], 5);
        type(A, 'Y');
        expect(md(A)).toBe('helloY\n\nsecond');
        expect(A.host.textContent).toBe('helloYsecond');
    });
});

describe('unbinding', () => {
    it('returns the editor to its own history and stops following the document', () => {
        const { A, B, exchange } = pair('abc');
        A.binding.destroy();
        caret(B, [0], 3);
        type(B, 'd');
        exchange();
        expect(md(A)).toBe('abc');
        caret(A, [0], 0);
        type(A, 'z');
        expect(md(A)).toBe('zabc');
        A.view.undo();
        expect(md(A)).toBe('abc');
    });
});

describe('random concurrent edits (seeded)', () => {
    // Small deterministic PRNG so a failure reproduces.
    const rng = (seed: number) => () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
    const textblocks = (doc: any): number[][] => {
        const out: number[][] = [];
        const walk = (n: any, p: number[]) => {
            if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock') { out.push(p); return; }
            (n.content || []).forEach((c: any, i: number) => walk(c, [...p, i]));
        };
        (doc.content || []).forEach((c: any, i: number) => walk(c, [i]));
        return out;
    };
    const blockLen = (doc: any, path: number[]) => {
        let n = doc;
        for (const i of path) n = n.content[i];
        return (n.content || []).reduce((acc: number, c: any) => acc + (c.type === 'text' ? c.text.length : 1), 0);
    };

    function randomEdit(s: Side, r: () => number) {
        const blocks = textblocks(s.view.state.doc);
        const path = blocks[Math.floor(r() * blocks.length)];
        const len = blockLen(s.view.state.doc, path);
        const at = Math.floor(r() * (len + 1));
        caret(s, path, at);
        const op = r();
        if (op < 0.45) type(s, String.fromCharCode(97 + Math.floor(r() * 26)));
        else if (op < 0.6) s.view.dispatch(T.deleteBackward, { kind: 'delete' });
        else if (op < 0.7) s.view.dispatch(T.splitBlock, { kind: 'structural' });
        else if (op < 0.8 && len > 1) {
            caret(s, path, 0, [path, Math.min(len, at + 2)]);
            s.view.dispatch((st: any) => T.toggleMark(st, 'bold'), { kind: 'format' });
        } else if (op < 0.9) s.view.dispatch((st: any) => T.toggleBlockType(st, 'heading', { level: 2 }), { kind: 'structural' });
        else s.view.dispatch((st: any) => T.toggleList(st, 'bulletList'), { kind: 'structural' });
    }

    for (const seed of [1, 7, 42, 1234]) {
        it(`converges after interleaved random edits (seed ${seed})`, () => {
            const r = rng(seed);
            const { A, B, exchange } = pair('alpha beta\n\ngamma delta\n\nepsilon');
            for (let round = 0; round < 25; round += 1) {
                randomEdit(A, r);
                randomEdit(B, r);
                if (r() < 0.5) exchange();
            }
            exchange();
            expectConverged(A, B);
        });
    }
});
