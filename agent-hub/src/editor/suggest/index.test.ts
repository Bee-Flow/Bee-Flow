import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { markdownToAst } from '../serialization/mdToAst.js';
import { astToMarkdown } from '../serialization/astToMd.js';
import { astToFragment, createYCache, fragmentToAst } from '../collab/yConvert';
import { syncDocToFragment } from '../collab/ySync';
import { posFromRelative, decodeRelpos } from '../collab/relpos';
import { FRAGMENT_NAME, type AstNode } from '../collab/ySchema';
import type { RelResolver } from '../react/anchors';
import { anchorsForFragment, applyHunks, hunksFrom, hunkWords } from './index';

const doc = (md: string): AstNode => markdownToAst(md) as AstNode;
const md = (d: AstNode): string => (astToMarkdown(d) as string).trim();
const P = (text: string): AstNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const D = (...texts: string[]): AstNode => ({ type: 'doc', content: texts.map(P) });
const texts = (d: AstNode): string[] => (d.content || []).map((b) => (b.content || []).map((c) => c.text).join(''));

const BASE = ['Alpha one.', 'Beta two.', 'Gamma three.', 'Delta four.', 'Epsilon five.'];

describe('hunksFrom', () => {
    it('no hunks for equal documents', () => {
        expect(hunksFrom(D(...BASE), D(...BASE))).toEqual({ hunks: [], replaceAll: false });
    });

    it('a changed paragraph is one hunk with a plain summary', () => {
        const { hunks, replaceAll } = hunksFrom(D(...BASE), D('Alpha one.', 'Beta TWO changed.', ...BASE.slice(2)));
        expect(replaceAll).toBe(false);
        expect(hunks).toHaveLength(1);
        expect(hunks[0].before).toEqual([P('Beta two.')]);
        expect(hunks[0].after).toEqual([P('Beta TWO changed.')]);
        expect(hunks[0].anchor).toMatchObject({ quote: 'Beta two.', prefix: 'Alpha one.\n', blockIndex: 1 });
        expect(hunks[0].summary).toBe('Rewrote paragraph "Beta two."');
    });

    it('an inserted paragraph is a pure insert anchored on its neighbour', () => {
        const { hunks } = hunksFrom(D(...BASE), D('Alpha one.', 'Beta two.', 'NEW', ...BASE.slice(2)));
        expect(hunks).toHaveLength(1);
        expect(hunks[0].before).toEqual([]);
        expect(hunks[0].after).toEqual([P('NEW')]);
        expect(hunks[0].anchor).toMatchObject({ blockIndex: 2, quote: 'Beta two.' });
        expect(hunks[0].summary).toBe('Added paragraph "NEW"');
    });

    it('a deleted paragraph is a pure delete', () => {
        const { hunks } = hunksFrom(D(...BASE), D(...BASE.filter((t) => t !== 'Gamma three.')));
        expect(hunks).toHaveLength(1);
        expect(hunks[0].before).toEqual([P('Gamma three.')]);
        expect(hunks[0].after).toEqual([]);
        expect(hunks[0].summary).toBe('Removed paragraph "Gamma three."');
    });

    it('replaceAll above maxHunks: one hunk with all blocks', () => {
        const prop = D('Alpha ONE.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon FIVE.');
        const r = hunksFrom(D(...BASE), prop, { maxHunks: 2 });
        expect(r.replaceAll).toBe(true);
        expect(r.hunks).toHaveLength(1);
        expect(r.hunks[0].before).toHaveLength(5);
        expect(r.hunks[0].after).toHaveLength(5);
        expect(applyHunks(D(...BASE), r.hunks).doc).toEqual(prop);
    });
});

describe('applyHunks', () => {
    it('applying all hunks gives the proposed document', () => {
        const cur = doc('# Title\n\nOne.\n\nTwo.\n\n- a\n- b\n\nLast.');
        const prop = doc('# New title\n\nOne.\n\nInserted.\n\nTwo.\n\n- a\n- b\n- c\n\n');
        const { hunks } = hunksFrom(cur, prop);
        expect(hunks.length).toBeGreaterThan(1);
        const r = applyHunks(cur, hunks);
        expect(r.stale).toEqual([]);
        expect(r.applied).toEqual(hunks.map((_, i) => i));
        expect(r.doc).toEqual(prop);
    });

    it('insert at the start and at the end', () => {
        const prop = D('FIRST', ...BASE, 'LAST');
        const { hunks } = hunksFrom(D(...BASE), prop);
        expect(hunks).toHaveLength(2);
        expect(applyHunks(D(...BASE), hunks).doc).toEqual(prop);
        // only the end insert, after the document grew at the top
        const r = applyHunks(D('Zero.', ...BASE), [hunks[1]]);
        expect(texts(r.doc)).toEqual(['Zero.', ...BASE, 'LAST']);
    });

    it('a block edited after hunksFrom makes that hunk stale; the others apply', () => {
        const prop = D('Alpha ONE.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon five.');
        const { hunks } = hunksFrom(D(...BASE), prop);
        expect(hunks).toHaveLength(2);
        const edited = D('Alpha one, edited by a person.', ...BASE.slice(1));
        const r = applyHunks(edited, hunks);
        expect(r.stale).toEqual([0]);
        expect(r.applied).toEqual([1]);
        expect(texts(r.doc)).toEqual(['Alpha one, edited by a person.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon five.']);
    });

    it('finds the block again when blocks were added above it', () => {
        const { hunks } = hunksFrom(D(...BASE), D('Alpha one.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon five.'));
        const r = applyHunks(D('x1', 'x2', 'x3', ...BASE), hunks);
        expect(r.stale).toEqual([]);
        expect(texts(r.doc)).toEqual(['x1', 'x2', 'x3', 'Alpha one.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon five.']);
    });

    it('a deleted block makes its hunk stale', () => {
        const { hunks } = hunksFrom(D(...BASE), D('Alpha one.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon five.'));
        const r = applyHunks(D(...BASE.filter((t) => t !== 'Gamma three.')), hunks);
        expect(r.stale).toEqual([0]);
        expect(r.applied).toEqual([]);
    });

    it('overlapping hunks: the first applies, the later one is stale', () => {
        const base = D(...BASE);
        const [a] = hunksFrom(base, D('Alpha one.', 'Beta X.', 'Gamma three.', 'Delta four.', 'Epsilon five.')).hunks;
        const [b] = hunksFrom(base, D('Alpha one.', 'Beta Y.', 'Gamma three.', 'Delta four.', 'Epsilon five.')).hunks;
        const r = applyHunks(base, [a, b]);
        expect(r.applied).toEqual([0]);
        expect(r.stale).toEqual([1]);
        expect(texts(r.doc)[1]).toBe('Beta X.');
        // a run covering two blocks vs a hunk on one of them
        const [wide] = hunksFrom(base, D('Alpha one.', 'B2', 'G2', 'Delta four.', 'Epsilon five.')).hunks;
        const r2 = applyHunks(base, [wide, a]);
        expect(r2.applied).toEqual([0]);
        expect(r2.stale).toEqual([1]);
    });

    it('inserts at one position keep their order, and an insert next to a replaced run applies', () => {
        const base = D(...BASE);
        const ins1 = hunksFrom(base, D('Alpha one.', 'I1', ...BASE.slice(1))).hunks[0];
        const ins2 = hunksFrom(base, D('Alpha one.', 'I2', ...BASE.slice(1))).hunks[0];
        expect(texts(applyHunks(base, [ins1, ins2]).doc).slice(1, 3)).toEqual(['I1', 'I2']);
        const rep = hunksFrom(base, D('Alpha one.', 'Beta NEW.', ...BASE.slice(2))).hunks[0];
        const r = applyHunks(base, [rep, ins1]);
        expect(r.stale).toEqual([]);
        expect(texts(r.doc).slice(0, 3)).toEqual(['Alpha one.', 'I1', 'Beta NEW.']);
    });

    it('nothing applied returns the same document', () => {
        const base = D(...BASE);
        expect(applyHunks(base, []).doc).toBe(base);
    });
});

describe('hunkWords', () => {
    it('word diff of a rewritten paragraph', () => {
        const { hunks } = hunksFrom(D('The quick brown fox.'), D('The slow brown fox.'));
        const w = hunkWords(hunks[0]);
        expect(w.beforeText).toBe('The quick brown fox.');
        expect(w.afterText).toBe('The slow brown fox.');
        expect(w.words).toEqual([
            { op: 'equal', text: 'The ' },
            { op: 'delete', text: 'quick' },
            { op: 'insert', text: 'slow' },
            { op: 'equal', text: ' brown fox.' },
        ]);
    });

    it('insert and delete hunks', () => {
        const ins = hunksFrom(D('A.'), D('A.', 'New text.')).hunks[0];
        expect(hunkWords(ins).words).toEqual([{ op: 'insert', text: 'New text.' }]);
        const del = hunksFrom(D('A.', 'Gone.'), D('A.')).hunks[0];
        expect(hunkWords(del)).toMatchObject({ beforeText: 'Gone.', afterText: '' });
        expect(hunkWords(del).words).toEqual([{ op: 'delete', text: 'Gone.' }]);
    });
});

describe('anchorsForFragment + a live resolver', () => {
    function live(ast: AstNode) {
        const ydoc = new Y.Doc();
        const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
        astToFragment(ast, fragment);
        const resolver: RelResolver = {
            toRel: () => null,
            fromRel: (b64) => {
                const r = decodeRelpos(b64);
                const p = r ? posFromRelative(fragment, ydoc, r) : null;
                return p ? { path: p.path, offset: p.offset } : null;
            },
        };
        return { ydoc, fragment, resolver };
    }

    it('adds relpos to anchors of runs with text, not to pure inserts', () => {
        const { fragment } = live(D(...BASE));
        const { hunks } = hunksFrom(D(...BASE), D('Alpha one.', 'Beta TWO.', 'Inserted', ...BASE.slice(2)));
        const out = anchorsForFragment(fragment, hunks);
        expect(out[0].anchor.relStart).toBeTruthy();
        expect(out[0].anchor.relEnd).toBeTruthy();
        const ins = hunksFrom(D(...BASE), D(...BASE, 'More')).hunks;
        expect(anchorsForFragment(fragment, ins)[0].anchor.relStart).toBeUndefined();
    });

    it('applies after a concurrent edit elsewhere, resolving through the shared document', () => {
        const base = D(...BASE);
        const { ydoc, fragment, resolver } = live(base);
        const prop = D('Alpha one.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon five.');
        const hunks = anchorsForFragment(fragment, hunksFrom(base, prop).hunks);
        // a second client inserts two blocks above the run and edits another paragraph
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
        const pf = peer.getXmlFragment(FRAGMENT_NAME);
        const edited = fragmentToAst(pf) as AstNode;
        astToFragment({ ...edited, content: [P('top1'), P('top2'), ...(edited.content || [])] }, pf);
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
        const now = fragmentToAst(fragment) as AstNode;
        expect(texts(now)).toEqual(['top1', 'top2', ...BASE]);
        const r = applyHunks(now, hunks, resolver);
        expect(r.stale).toEqual([]);
        expect(texts(r.doc)).toEqual(['top1', 'top2', 'Alpha one.', 'Beta two.', 'Gamma THREE.', 'Delta four.', 'Epsilon five.']);
        expect(md(r.doc)).toContain('Gamma THREE.');
    });

    it('relpos alone picks the right one of two identical paragraphs after blocks above it were removed', () => {
        const base = D('Intro.', 'Dup text.', 'Middle.', 'Dup text.');
        const { ydoc, fragment, resolver } = live(base);
        // The AI rewrites the FIRST "Dup text." (block 1).
        const hunks = anchorsForFragment(fragment, hunksFrom(base, D('Intro.', 'Dup REWRITTEN.', 'Middle.', 'Dup text.')).hunks);
        expect(hunks[0].anchor.blockIndex).toBe(1);
        expect(hunks[0].anchor.relStart).toBeTruthy();
        // A peer removes the two blocks around it, with the minimal-diff sync so the shared text keeps its identity.
        const peer = new Y.Doc();
        Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
        const pf = peer.getXmlFragment(FRAGMENT_NAME);
        const cache = createYCache();
        const seen = fragmentToAst(pf, cache) as AstNode;
        syncDocToFragment(pf, { ...seen, content: [P('Dup text.'), P('Dup text.')].map((b, i) => (seen.content || [])[i * 2 + 1] || b) }, cache);
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));
        const now = fragmentToAst(fragment) as AstNode;
        expect(texts(now)).toEqual(['Dup text.', 'Dup text.']);
        // blockIndex 1 now points at the OTHER duplicate: without the resolver the hunk lands there.
        expect(texts(applyHunks(now, hunks).doc)).toEqual(['Dup text.', 'Dup REWRITTEN.']);
        // With relpos it lands on the first one.
        const r = applyHunks(now, hunks, resolver);
        expect(r.stale).toEqual([]);
        expect(texts(r.doc)).toEqual(['Dup REWRITTEN.', 'Dup text.']);
    });
});
