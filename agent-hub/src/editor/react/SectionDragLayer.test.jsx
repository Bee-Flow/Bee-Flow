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
