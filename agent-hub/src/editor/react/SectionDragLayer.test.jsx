import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SectionDragLayer from './SectionDragLayer.jsx';

// A switchable dictionary layered over the REAL useTranslation, off by default
// so the plain runs read the shipped English. Switched on below to prove the
// drag handle's title survives translation WITH its `{level}` placeholder:
// with English fallbacks a working interpolation and a broken one are hard to
// tell apart, because the fallback used to be a JS template literal that had
// already baked the number in. The dictionary value is the path that was
// actually patched afterwards with `.replace('{level}', …)`.
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../hooks/useTranslation', async (importOriginal) =>
  (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

/**
 * The layer only needs a host with block children and a view whose doc says
 * what each block is. jsdom hands back an all-zero rect for every element, so
 * a mousemove at clientY 0 lands on the first block.
 */
function Harness({ node }) {
  const hostRef = useRef(null);
  const viewRef = useRef({ state: { doc: { content: [node] } } });
  return (
    <div data-testid="wrap">
      <div ref={hostRef}><p>block</p></div>
      <SectionDragLayer hostRef={hostRef} viewRef={viewRef} />
    </div>
  );
}

const HEADING = { type: 'heading', attrs: { level: 2 } };
const PARAGRAPH = { type: 'paragraph', attrs: {} };

function hover(node) {
  render(<Harness node={node} />);
  fireEvent.mouseMove(screen.getByTestId('wrap'), { clientY: 0 });
}

describe('SectionDragLayer — drag handle title', () => {
  beforeEach(() => { cleanup(); transOverride.current = null; });

  it('names the heading level in the English fallback', () => {
    hover(HEADING);
    expect(screen.getByTitle('Drag to move the whole H2 section')).toBeTruthy();
  });

  it('interpolates {level} into a TRANSLATED title too', () => {
    // The params argument has to reach t(). The old local shim called t(key)
    // and picked the fallback itself, so the placeholder came back untouched
    // and the component had to patch the result with .replace() — which is
    // why it worked here but never on the fallback.
    transOverride.current = { 'notebooks.drag_section': 'Sleep de hele H{level}-sectie' };
    hover(HEADING);
    expect(screen.getByTitle('Sleep de hele H2-sectie')).toBeTruthy();
    expect(screen.queryByTitle('Sleep de hele H{level}-sectie')).toBeNull();
  });

  it('uses the plain block title for a non-heading, translated when the key exists', () => {
    hover(PARAGRAPH);
    expect(screen.getByTitle('Drag to reorder this block')).toBeTruthy();
    cleanup();
    transOverride.current = { 'notebooks.drag_block': 'Sleep dit blok' };
    hover(PARAGRAPH);
    expect(screen.getByTitle('Sleep dit blok')).toBeTruthy();
  });
});

/**
 * A drag while someone else edits: the layer holds a view whose document the
 * test replaces mid-drag, as a co-editor's change does (every block copied).
 * jsdom rects are all zero, so the handle is found at clientY 0 on the first
 * block and a drop at clientY 0 lands after the last one.
 */
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

function DragHarness({ view, isLocked }) {
  const hostRef = useRef(null);
  const viewRef = useRef(view);
  return (
    <div data-testid="wrap">
      <div ref={hostRef} data-testid="host">{view.state.doc.content.map((_, i) => <p key={i}>block</p>)}</div>
      <SectionDragLayer hostRef={hostRef} viewRef={viewRef} isLocked={isLocked} />
    </div>
  );
}

function dragView(texts) {
  const view = {
    state: { doc: { type: 'doc', content: texts.map(para) }, selection: null },
    dispatch: (fn) => { view.state = fn(view.state); },
  };
  return view;
}
const texts = (view) => view.state.doc.content.map((b) => b.content[0].text);

function startDragOnFirstBlock(view, isLocked = null) {
  render(<DragHarness view={view} isLocked={isLocked} />);
  fireEvent.mouseMove(screen.getByTestId('wrap'), { clientY: 0 });
  fireEvent.mouseDown(screen.getByTitle('Drag to reorder this block'));
}

/** A co-editor adds a block at the top: every index shifts, every block is a copy. */
function remoteInsertAtTop(view, text) {
  view.state = { ...view.state, doc: { type: 'doc', content: [para(text), ...JSON.parse(JSON.stringify(view.state.doc.content))] } };
  const host = screen.getByTestId('host');
  host.insertBefore(document.createElement('p'), host.firstChild);
}

describe('SectionDragLayer — others editing during a drag', () => {
  beforeEach(() => { cleanup(); transOverride.current = null; });

  it('moves the block that was grabbed, not the one now at its old index', () => {
    const view = dragView(['a', 'b', 'c']);
    startDragOnFirstBlock(view);
    remoteInsertAtTop(view, 'x');
    fireEvent.mouseUp(document, { clientY: 0 });
    expect(texts(view)).toEqual(['x', 'b', 'c', 'a']);
  });

  it('asks again at the drop whether someone is editing in there, and then moves nothing', () => {
    const view = dragView(['a', 'b', 'c']);
    let lockedAtDrop = false;
    const isLocked = vi.fn(() => lockedAtDrop);
    startDragOnFirstBlock(view, isLocked);
    lockedAtDrop = true;
    fireEvent.mouseUp(document, { clientY: 0 });
    expect(texts(view)).toEqual(['a', 'b', 'c']);
    expect(isLocked).toHaveBeenLastCalledWith(0, 1);
  });

  it('moves nothing when the grabbed block was changed meanwhile', () => {
    const view = dragView(['a', 'b', 'c']);
    startDragOnFirstBlock(view);
    view.state = { ...view.state, doc: { type: 'doc', content: [para('a, edited'), para('b'), para('c')] } };
    fireEvent.mouseUp(document, { clientY: 0 });
    expect(texts(view)).toEqual(['a, edited', 'b', 'c']);
  });
});

