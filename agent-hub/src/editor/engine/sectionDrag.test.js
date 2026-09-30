// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { findBlocks, getSectionRange, moveBlocks } from './sectionDrag.js';
import { createState, applyTransform } from './state.js';
import { astToMarkdown } from '../serialization/astToMd.js';
import { markdownToAst } from '../serialization/mdToAst.js';

const docFrom = (md) => createState(markdownToAst(md)).doc;

describe('getSectionRange', () => {
  it('an H1 section extends to the next H1', () => {
    const doc = docFrom('# A\n\nx\n\n# B');
    expect(getSectionRange(doc, 0)).toBe(2);
    expect(getSectionRange(doc, 2)).toBe(1);
  });

  it('an H1 section includes nested sub-sections', () => {
    const doc = docFrom('# A\n\n## B\n\ny\n\n# C');
    expect(getSectionRange(doc, 0)).toBe(3);
    expect(getSectionRange(doc, 1)).toBe(2);
  });

  it('a non-heading block is a section of one', () => {
    const doc = docFrom('para one\n\npara two');
    expect(getSectionRange(doc, 0)).toBe(1);
  });
});

describe('moveBlocks', () => {
  it('moves a heading section to the end', () => {
    let s = createState(markdownToAst('# A\n\nx\n\n# B'));
    s = applyTransform(s, (st) => moveBlocks(st, 0, 2, 3));
    expect(astToMarkdown(s.doc).trim()).toBe('# B\n\n# A\n\nx');
  });

  it('is a no-op when dropping inside the source range', () => {
    const s0 = createState(markdownToAst('# A\n\nx\n\n# B'));
    const s1 = applyTransform(s0, (st) => moveBlocks(st, 0, 2, 1));
    expect(astToMarkdown(s1.doc).trim()).toBe('# A\n\nx\n\n# B');
  });
});

describe('findBlocks', () => {
  const doc = (md) => docFrom(md);

  it('finds blocks where they were, by identity', () => {
    const d = doc('# A\n\nx\n\n# B');
    expect(findBlocks(d, d.content.slice(0, 2), 0)).toBe(0);
  });

  it('follows blocks that moved down after an insert above them, compared by value', () => {
    const before = doc('one\n\ntwo\n\nthree');
    const after = doc('new\n\none\n\ntwo\n\nthree');
    expect(findBlocks(after, before.content.slice(1, 3), 1)).toBe(2);
  });

  it('gives up when a block changed or the run was split', () => {
    const before = doc('one\n\ntwo\n\nthree');
    expect(findBlocks(doc('one\n\ntwo!\n\nthree'), before.content.slice(1, 2), 1)).toBe(-1);
    expect(findBlocks(doc('one\n\ntwo\n\nnew\n\nthree'), before.content.slice(1, 3), 1)).toBe(-1);
  });

  it('picks the copy nearest to where the blocks were', () => {
    const d = doc('same\n\nother\n\nsame');
    const grabbed = doc('same').content.slice(0, 1);
    expect(findBlocks(d, grabbed, 2)).toBe(2);
    expect(findBlocks(d, grabbed, 0)).toBe(0);
  });
});

