import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import BeeEditor from './BeeEditor.jsx';

/**
 * The empty-document placeholder is drawn by CSS from a custom property, so
 * the assertion reads `--bf-placeholder` off the editable host.
 *
 * A switchable `t` over the real hook: `notebooks.placeholder` IS in the
 * shipped catalogue, so mounting with the real one would only ever prove what
 * the dictionary says today. `override.current = {}` models the key being
 * absent — the case that used to end in a hardcoded Dutch sentence inside an
 * English source file.
 */
const { override } = vi.hoisted(() => ({ override: { current: null } }));
vi.mock('../../hooks/useTranslation', async (importOriginal) => {
  const actual = await importOriginal();
  const useTranslation = () => {
    const real = actual.useTranslation();
    const over = override.current;
    if (!over) return real;
    return { ...real, t: (key, fb) => (key in over ? over[key] : (typeof fb === 'string' ? fb : key)) };
  };
  return { ...actual, useTranslation, default: useTranslation };
});

const EN = 'Start writing… Type $formula$ for math, :emoji: for emoji, or use the toolbar.';

function placeholderOf(props = {}) {
  const { container } = render(<BeeEditor content="" notebookId="nb1" {...props} />);
  const host = container.querySelector('[contenteditable]') || container.querySelector('.bf-editor-host, .ProseMirror') || container.firstElementChild;
  return { host, value: host?.style.getPropertyValue('--bf-placeholder') };
}

describe('BeeEditor — placeholder', () => {
  beforeEach(() => { cleanup(); override.current = null; });

  it('falls back to English, not Dutch, when the key is missing', () => {
    override.current = {};
    const { value } = placeholderOf();
    expect(value).toBe(`"${EN}"`);
    expect(value).not.toMatch(/Begin met schrijven/);
  });

  it('prefers the dictionary over the English fallback', () => {
    override.current = { 'notebooks.placeholder': 'Begin met typen…' };
    const { value } = placeholderOf();
    expect(value).toBe('"Begin met typen…"');
  });

  it('lets an explicit placeholder prop win over the dictionary', () => {
    override.current = { 'notebooks.placeholder': 'Begin met typen…' };
    const { value } = placeholderOf({ placeholder: 'Notes for this meeting' });
    expect(value).toBe('"Notes for this meeting"');
  });
});
