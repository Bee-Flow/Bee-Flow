/**
 * rebaseDoc — a whole-document rewrite made from a snapshot, carried onto a
 * document that co-editors changed since: the rewrite lands, their work stays.
 */
import { describe, expect, it } from 'vitest';
import { markdownToAst } from '../serialization/mdToAst.js';
import { astToMarkdown } from '../serialization/astToMd.js';
import { rebaseDoc } from './rebaseDoc';
import type { AstNode } from './ySchema';

const md = (s: string) => markdownToAst(s) as AstNode;
const text = (n: AstNode) => String(astToMarkdown(n)).trim();

describe('rebaseDoc', () => {
    it('returns the rewrite itself when nothing changed since the snapshot', () => {
        const base = md('Intro {{name}}\n\nSecond');
        const next = md('Intro Alice\n\nSecond');
        expect(rebaseDoc(base, md('Intro {{name}}\n\nSecond'), next)).toBe(next);
    });

    it('keeps a paragraph added since, and the rewrite\'s own change', () => {
        const out = rebaseDoc(md('Intro {{name}}\n\nSecond'), md('Intro {{name}}\n\nSecond\n\nB wrote this'), md('Intro Alice\n\nSecond'));
        expect(text(out)).toBe('Intro Alice\n\nSecond\n\nB wrote this');
    });

    it('keeps words typed since into the paragraph the rewrite changes', () => {
        const out = rebaseDoc(md('Dear {{name}}, welcome.'), md('Dear {{name}}, welcome. See you soon.'), md('Dear Alice, welcome.'));
        expect(text(out)).toBe('Dear Alice, welcome. See you soon.');
    });

    it('keeps a deletion made since in a part the rewrite did not touch', () => {
        const out = rebaseDoc(md('{{a}}\n\nObsolete\n\nKeep'), md('{{a}}\n\nKeep'), md('Filled\n\nObsolete\n\nKeep'));
        expect(text(out)).toBe('Filled\n\nKeep');
    });
});
