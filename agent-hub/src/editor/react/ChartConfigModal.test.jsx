import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ChartConfigModal from './ChartConfigModal.jsx';

/**
 * The four chart-type buttons: they were hardcoded English inside the TYPES
 * table, and hardcoded English renders exactly like translated English — so
 * the only way to show a label now travels through a KEY is to make that key
 * answer in another language and watch the screen change. That is what the
 * override dictionary below is for.
 *
 * The second half of this file guards the rename the translation forced. `key`
 * in that table used to be the chart TYPE ('bar' | 'line' | 'area' | 'pie'),
 * read in three places at once — the React list key, `setType(key)` and
 * `type === key` — and it had to become `id` so `key` could mean what it means
 * everywhere else in the tree. A rename across three readers is exactly the
 * kind that type-checks, renders, and quietly stops selecting anything.
 *
 * t arrives as a PROP here (not through useTranslation), so no module mock is
 * needed: a plain function is the whole seam.
 */
const makeT = (over = {}) => (key, fallback, params) => {
  const text = key in over ? over[key] : fallback;
  return String(text ?? key).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
};

// Three columns on purpose: column 0 is the labels, so the series start out as
// TWO selected columns — the only starting point at which "pie squeezes the
// selection to one" is a visible event and not a no-op.
const props = (over = {}) => ({
  columns: ['Month', 'Revenue', 'Cost'],
  rows: [['Jan', '1', '2'], ['Feb', '3', '4']],
  onCreate: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

describe('ChartConfigModal — the chart-type labels are translatable', () => {
  beforeEach(() => cleanup());

  it('renders the four English fallbacks when the dictionary is silent', () => {
    render(<ChartConfigModal {...props()} t={makeT()} />);
    for (const label of ['Bar', 'Line', 'Area', 'Pie']) {
      expect(screen.getByText(label), `${label} button`).toBeTruthy();
    }
  });

  it('renders the Dutch text when the four keys answer', () => {
    // The proof that the labels go through notebooks.chart_type_* and are not
    // still the bare strings from the table: change the dictionary, and every
    // one of the four changes with it.
    const t = makeT({
      'notebooks.chart_type_bar': 'Staaf',
      'notebooks.chart_type_line': 'Lijn',
      'notebooks.chart_type_area': 'Vlak',
      'notebooks.chart_type_pie': 'Taart',
    });
    render(<ChartConfigModal {...props()} t={t} />);
    for (const nl of ['Staaf', 'Lijn', 'Vlak', 'Taart']) {
      expect(screen.getByText(nl), `${nl} button`).toBeTruthy();
    }
    for (const en of ['Bar', 'Line', 'Area', 'Pie']) {
      expect(screen.queryByText(en), `${en} must be gone`).toBeNull();
    }
  });

  it('asks t for each type key WITH its English fallback beside it', () => {
    // t('key') alone returns the raw key on a miss, so a fallback that is not
    // passed to t is a fallback that never fires. Assert the pair, not the
    // rendered text — the rendered text is identical either way.
    const seen = new Map();
    const t = (key, fallback) => { seen.set(key, fallback); return fallback; };
    render(<ChartConfigModal {...props()} t={t} />);
    expect(seen.get('notebooks.chart_type_bar')).toBe('Bar');
    expect(seen.get('notebooks.chart_type_line')).toBe('Line');
    expect(seen.get('notebooks.chart_type_area')).toBe('Area');
    expect(seen.get('notebooks.chart_type_pie')).toBe('Pie');
  });
});

describe('ChartConfigModal — the key→id rename still selects a type', () => {
  beforeEach(() => cleanup());

  const create = (onCreate, t = makeT()) => {
    render(<ChartConfigModal {...props({ onCreate })} t={t} />);
    return () => fireEvent.click(screen.getByText('Create'));
  };

  it('clicking Pie sets the type to pie and creates a single-series chart', () => {
    const onCreate = vi.fn();
    const submit = create(onCreate);
    fireEvent.click(screen.getByText('Pie'));
    submit();
    expect(onCreate).toHaveBeenCalledTimes(1);
    const arg = onCreate.mock.calls[0][0];
    expect(arg.type).toBe('pie');
    expect(arg.series.map(s => s.name)).toEqual(['Revenue']);
  });

  it('the pie click squeezes the selection itself — switching back keeps one series', () => {
    // create() slices to one for a pie anyway, so a pie-only assertion cannot
    // tell whether the CLICK squeezed anything. Going pie → bar can: the
    // selection stays at one column only if the click handler really ran.
    const onCreate = vi.fn();
    const submit = create(onCreate);
    fireEvent.click(screen.getByText('Pie'));
    fireEvent.click(screen.getByText('Bar'));
    submit();
    const arg = onCreate.mock.calls[0][0];
    expect(arg.type).toBe('bar');
    expect(arg.series.map(s => s.name)).toEqual(['Revenue']);
  });

  it('leaves both series selected while nobody picks pie', () => {
    // The other side of the same coin: without the pie click the default two
    // columns survive, so the assertion above is about the click and not about
    // the modal simply never having two series.
    const onCreate = vi.fn();
    const submit = create(onCreate);
    fireEvent.click(screen.getByText('Line'));
    submit();
    const arg = onCreate.mock.calls[0][0];
    expect(arg.type).toBe('line');
    expect(arg.series.map(s => s.name)).toEqual(['Revenue', 'Cost']);
  });

  it('marks the picked type as the active button, translated or not', () => {
    // `type === id` is the third reader of the renamed field. It only shows up
    // in the accent colour, so it is asserted on the style rather than on text.
    const t = makeT({ 'notebooks.chart_type_area': 'Vlak' });
    render(<ChartConfigModal {...props()} t={t} />);
    const area = screen.getByText('Vlak').closest('button');
    expect(area.style.borderColor).not.toContain('accent-primary');
    fireEvent.click(area);
    expect(area.style.borderColor).toContain('accent-primary');
  });
});
