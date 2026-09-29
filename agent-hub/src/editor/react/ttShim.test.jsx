import fs from 'node:fs';
import path from 'node:path';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ChartConfigModal from './ChartConfigModal.jsx';
import { mkTt } from './toolbarPrimitives.jsx';
import { interpolate } from '../../hooks/useTranslation';

/**
 * One shim, in one place.
 *
 * The editor grew five copies of the same translate-with-fallback helper, and
 * four of them were the WRONG spelling:
 *
 *     const tt = (k, fb) => { const v = t ? t(k) : null; return v && v !== k ? v : fb; };
 *
 * That form calls the ONE-argument `t(k)` and judges the result itself, which
 * does two wrong things at once: it is the banned `t(key) || fallback` idiom in
 * disguise, and it has no third parameter, so any caller passing `{ axis: 'X' }`
 * gets a string with `{axis}` still in it. The i18n guard cannot see it — its
 * two `||`-bans both require a literal key AND a `||`, and this spelling has
 * neither — and no test imported ChartConfigModal at all, so the trap sat there
 * silently waiting for the first interpolating caller.
 */

const HERE = path.resolve(process.cwd(), 'src/editor/react');

/** The real `t`, in miniature: dictionary → string fallback → key, then params. */
const makeT = (dict) => (key, fallbackOrParams, paramsArg) => {
  const hasStringFallback = typeof fallbackOrParams === 'string';
  const params = hasStringFallback ? paramsArg : fallbackOrParams;
  let value = dict[key];
  if (typeof value !== 'string') value = hasStringFallback ? fallbackOrParams : key;
  return interpolate(value, params);
};

describe('mkTt — the shared shim forwards what the old copies swallowed', () => {
  it('interpolates params into a DICTIONARY value', () => {
    const tt = mkTt(makeT({ 'notebooks.chart_labels': 'Labels ({axis}-as)' }));
    expect(tt('notebooks.chart_labels', 'Labels ({axis} axis)', { axis: 'X' })).toBe('Labels (X-as)');
  });

  it('interpolates params into the ENGLISH FALLBACK too', () => {
    // The old shim could not reach this path at all: it resolved the fallback
    // itself, after `t` had already returned, so a missing key rendered the
    // raw placeholder to the user.
    const tt = mkTt(makeT({}));
    expect(tt('notebooks.chart_labels', 'Labels ({axis} axis)', { axis: 'X' })).toBe('Labels (X axis)');
  });

  it('survives a missing t — its only real job beyond passing through', () => {
    expect(mkTt(null)('any.key', 'Fallback')).toBe('Fallback');
  });

  it('and here is what the OLD spelling did with the same input', () => {
    // Kept as an executable record of the defect, so nobody reintroduces the
    // shape thinking it was equivalent.
    const t = makeT({ 'notebooks.chart_labels': 'Labels ({axis}-as)' });
    const oldShim = (k, fb) => { const v = t ? t(k) : null; return v && v !== k ? v : fb; };
    expect(oldShim('notebooks.chart_labels', 'Labels ({axis} axis)', { axis: 'X' })).toBe('Labels ({axis}-as)');
  });
});

describe('editor/react holds no hand-rolled copy of the shim', () => {
  const sources = fs.readdirSync(HERE)
    .filter(f => /\.jsx?$/.test(f) && !f.includes('.test.'))
    .map(f => ({ f, src: fs.readFileSync(path.join(HERE, f), 'utf8') }));

  it('reads more than a handful of modules — a silent empty scan proves nothing', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it('declares every `tt` as mkTt(t), never as a local re-implementation', () => {
    const offenders = [];
    for (const { f, src } of sources) {
      for (const m of src.matchAll(/const\s+tt\s*=\s*([^\n]*)/g)) {
        const rhs = m[1].trim();
        // toolbarPrimitives.jsx is where mkTt itself is defined.
        if (rhs.startsWith('mkTt(')) continue;
        offenders.push(`${f}: const tt = ${rhs.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never calls t with a single argument and judges the answer itself', () => {
    // The signature of the banned spelling, in any file: `t(x)` compared back
    // against the key. A literal-key `||` ban would miss all four copies.
    const offenders = [];
    for (const { f, src } of sources) {
      if (/!==\s*(key|k)\s*\?/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('ChartConfigModal — the modal nobody had ever mounted', () => {
  beforeEach(() => cleanup());

  const props = () => ({
    columns: ['Month', 'Revenue'],
    rows: [['Jan', '1'], ['Feb', '2']],
    onCreate: vi.fn(),
    onClose: vi.fn(),
  });

  it('hands every chrome string to t WITH its English fallback', () => {
    // The old shim called t(key) and appended the fallback afterwards, so `t`
    // never saw it. That is the difference this asserts — not the rendered
    // text, which was identical either way.
    const calls = [];
    const t = (key, fallback, params) => { calls.push([key, fallback, params]); return makeT({})(key, fallback, params); };
    render(<ChartConfigModal {...props()} t={t} />);

    expect(calls.length).toBeGreaterThan(4);
    for (const [key, fallback] of calls) {
      expect(typeof key).toBe('string');
      expect(typeof fallback).toBe('string');
      expect(fallback).not.toBe('');
    }
  });

  it('shows a translated title instead of the English fallback', () => {
    const t = makeT({ 'notebooks.create_chart': 'Grafiek maken' });
    render(<ChartConfigModal {...props()} t={t} />);
    expect(screen.getByText('Grafiek maken')).toBeTruthy();
    expect(screen.queryByText('Create chart')).toBeNull();
  });

  it('still renders without a t at all', () => {
    render(<ChartConfigModal {...props()} t={undefined} />);
    expect(screen.getByText('Create chart')).toBeTruthy();
  });
});
