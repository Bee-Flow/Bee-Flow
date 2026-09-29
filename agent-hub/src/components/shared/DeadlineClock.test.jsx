import { act, render, renderHook, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeadlineClock, { clockLabel, clockShortLabel, resolveClock, useNow } from './DeadlineClock';
import { DAY_MS, HOUR_MS } from './deadlineMath';

/**
 * One clock, four variants (artboards 1a/1c and the rail). Pinned here:
 *   - the label is the SAME sentence on every variant, with the number the
 *     math produced ("still 18 days", "overdue by 3 days", "still 41 hours");
 *   - ink for the text, raw for the bar — never the other way round;
 *   - a server `state`/`pct` beats the local arithmetic (GET /deadlines
 *     knows about extensions and the authority's clock);
 *   - closed clocks (done / none) draw no bar and the rail draws nothing.
 */

vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, vars) => {
            const base = typeof fallback === 'string' ? fallback : key;
            const params = typeof fallback === 'string' ? vars : fallback;
            return params ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), base) : base;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const NOW = new Date('2026-09-14T09:12:00Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

// The DSR fixtures from artboard 1c.
const DSR_LATE = { startedAt: iso(NOW - 32.8 * DAY_MS), dueAt: iso(NOW - 2.8 * DAY_MS), urgentBelowMs: 5 * DAY_MS };
const DSR_OK = { startedAt: iso(NOW - 12 * DAY_MS), dueAt: iso(NOW + 18 * DAY_MS), urgentBelowMs: 5 * DAY_MS };
const INC_72H = { startedAt: iso(NOW - 31 * HOUR_MS), dueAt: iso(NOW + 41 * HOUR_MS), urgentBelowMs: 24 * HOUR_MS };

describe('DeadlineClock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('row: overdue DSR — error ink on the label, error raw on a full bar, Timer glyph', () => {
        render(<DeadlineClock {...DSR_LATE} variant="row" testId="c" />);
        const el = screen.getByTestId('c');
        expect(el.dataset.state).toBe('overdue');
        expect(el.dataset.unit).toBe('days');
        expect(el.textContent).toBe('overdue by 3 days');
        const label = el.firstElementChild;
        expect(label.style.color).toBe('var(--error-ink)');
        expect(label.querySelector('svg')).not.toBeNull();
        const bar = screen.getByTestId('c-bar');
        expect(bar.style.width).toBe('100%');
        expect(bar.style.background).toBe('var(--error)');
    });

    it('row: 18 days left is success ink and a bar at the elapsed share', () => {
        render(<DeadlineClock {...DSR_OK} variant="row" testId="c" />);
        const el = screen.getByTestId('c');
        expect(el.dataset.state).toBe('ok');
        expect(el.textContent).toBe('still 18 days');
        expect(el.firstElementChild.style.color).toBe('var(--success-ink)');
        expect(parseFloat(screen.getByTestId('c-bar').style.width)).toBeCloseTo(40, 0);
        expect(screen.getByTestId('c-bar').style.background).toBe('var(--success)');
    });

    it('row: the 72-hour incident clock counts in hours and is warning below 24 h', () => {
        const { rerender } = render(<DeadlineClock {...INC_72H} variant="row" testId="c" />);
        expect(screen.getByTestId('c').textContent).toBe('still 41 hours');
        expect(screen.getByTestId('c').dataset.state).toBe('ok');
        rerender(<DeadlineClock {...INC_72H} dueAt={iso(NOW + 20 * HOUR_MS)} startedAt={iso(NOW - 52 * HOUR_MS)} variant="row" testId="c" />);
        const el = screen.getByTestId('c');
        expect(el.textContent).toBe('still 20 hours');
        expect(el.dataset.state).toBe('urgent');
        expect(el.firstElementChild.style.color).toBe('var(--warning-ink)');
        expect(screen.getByTestId('c-bar').style.background).toBe('var(--warning)');
    });

    it('row: done and none are quiet tertiary text with no bar and no glyph', () => {
        const { rerender } = render(
            <DeadlineClock startedAt={iso(NOW - 40 * DAY_MS)} dueAt={iso(NOW - 10 * DAY_MS)} doneAt={iso(NOW - 22 * DAY_MS)} variant="row" testId="c" />,
        );
        let el = screen.getByTestId('c');
        expect(el.dataset.state).toBe('done');
        expect(el.textContent).toBe('completed in 18 days');
        expect(el.style.color).toBe('var(--text-tertiary)');
        expect(screen.queryByTestId('c-bar')).toBeNull();
        expect(el.querySelector('svg')).toBeNull();

        rerender(<DeadlineClock variant="row" testId="c" />);
        el = screen.getByTestId('c');
        expect(el.dataset.state).toBe('none');
        expect(el.textContent).toBe('no open deadline');
        expect(screen.queryByTestId('c-bar')).toBeNull();
    });

    it('row: a doneLabel replaces the sentence for a closed clock', () => {
        render(<DeadlineClock doneAt={iso(NOW)} doneLabel="export e-mailed 21 Aug" variant="row" testId="c" />);
        expect(screen.getByTestId('c').textContent).toBe('export e-mailed 21 Aug');
    });

    it('block: 8 % tint of the raw tone, 15px/700 label, 4px bar on the card colour, meta children', () => {
        render(
            <DeadlineClock {...DSR_LATE} variant="block" testId="c">
                received 12 Aug 14:02 · due 11 Sep · not extended
            </DeadlineClock>,
        );
        const el = screen.getByTestId('c');
        expect(el.style.background).toBe('color-mix(in srgb, var(--error) 8%, transparent)');
        const label = el.firstElementChild;
        expect(label.className).toMatch(/text-\[15px\]/);
        expect(label.className).toMatch(/font-bold/);
        expect(label.style.color).toBe('var(--error-ink)');
        expect(label.textContent).toBe('overdue by 3 days');
        const track = screen.getByTestId('c-bar').parentElement;
        expect(track.className).toMatch(/\bh-1\b/);
        expect(track.className).toMatch(/bg-\[var\(--bg-card\)\]/);
        expect(el.textContent).toContain('received 12 Aug 14:02');
    });

    it('inline: text only, ink coloured, no glyph, no bar', () => {
        render(<DeadlineClock {...DSR_OK} variant="inline" testId="c" />);
        const el = screen.getByTestId('c');
        expect(el.tagName).toBe('SPAN');
        expect(el.textContent).toBe('still 18 days');
        expect(el.style.color).toBe('var(--success-ink)');
        expect(el.querySelector('svg')).toBeNull();
        expect(screen.queryByTestId('c-bar')).toBeNull();
    });

    it('rail: Timer + the short value — a bare day count, "{n} h" for hours — and nothing when closed', () => {
        const { rerender } = render(<DeadlineClock {...DSR_LATE} variant="rail" testId="c" />);
        let el = screen.getByTestId('c');
        expect(el.textContent).toBe('3');
        expect(el.style.color).toBe('var(--error-ink)');
        expect(el.querySelector('svg')).not.toBeNull();
        expect(el.getAttribute('title')).toBe('overdue by 3 days');

        rerender(<DeadlineClock {...INC_72H} variant="rail" testId="c" />);
        expect(screen.getByTestId('c').textContent).toBe('41 h');

        rerender(<DeadlineClock doneAt={iso(NOW)} variant="rail" testId="c" />);
        expect(screen.queryByTestId('c')).toBeNull();
        rerender(<DeadlineClock variant="rail" testId="c" />);
        expect(screen.queryByTestId('c')).toBeNull();
    });

    it('a server state and pct win over the local math', () => {
        // Locally this is 18 days of ok; the server says it is overdue at 100 %.
        render(<DeadlineClock {...DSR_OK} state="overdue" pct={1} variant="row" testId="c" />);
        const el = screen.getByTestId('c');
        expect(el.dataset.state).toBe('overdue');
        expect(el.dataset.tone).toBe('error');
        expect(screen.getByTestId('c-bar').style.width).toBe('100%');
        expect(el.textContent).toMatch(/^overdue by/);
    });

    it('a server pct alone reshapes the bar without changing the verdict', () => {
        render(<DeadlineClock {...DSR_OK} pct={0.9} variant="row" testId="c" />);
        expect(screen.getByTestId('c').dataset.state).toBe('ok');
        expect(screen.getByTestId('c-bar').style.width).toBe('90%');
    });

    it('an unknown server state falls back to the math', () => {
        render(<DeadlineClock {...DSR_OK} state="late" variant="inline" testId="c" />);
        expect(screen.getByTestId('c').dataset.state).toBe('ok');
    });

    it('a server "done" without a local doneAt still closes the clock', () => {
        render(<DeadlineClock {...DSR_OK} state="done" variant="row" testId="c" />);
        const el = screen.getByTestId('c');
        expect(el.dataset.state).toBe('done');
        expect(el.textContent).toBe('completed');
        expect(screen.queryByTestId('c-bar')).toBeNull();
    });

    it('the label ticks with the wall clock: an hour later a 41-hour clock says 40', () => {
        render(<DeadlineClock {...INC_72H} variant="inline" testId="c" />);
        expect(screen.getByTestId('c').textContent).toBe('still 41 hours');
        act(() => {
            vi.setSystemTime(NOW + HOUR_MS + 1000);
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByTestId('c').textContent).toBe('still 40 hours');
    });
});

describe('useNow / helpers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('useNow re-reads the clock on its interval and stops when unmounted', () => {
        const { result, unmount } = renderHook(() => useNow(1000));
        expect(result.current).toBe(NOW);
        act(() => {
            vi.setSystemTime(NOW + 5000);
            vi.advanceTimersByTime(1000); // fake timers move the system clock along with them
        });
        expect(result.current).toBe(NOW + 6000);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('useNow(0) reads once and sets no timer', () => {
        renderHook(() => useNow(0));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clockLabel / clockShortLabel speak with t(key, fallback, vars)', () => {
        const t = (key, fallback, vars) => `${key}|${fallback}|${JSON.stringify(vars ?? null)}`;
        expect(clockLabel(t, { state: 'ok', unit: 'days', value: 18 })).toBe('compliance.clock_days_left|still {days} days|{"days":18}');
        expect(clockLabel(t, { state: 'urgent', unit: 'hours', value: 20 })).toBe('compliance.clock_hours_left|still {hours} hours|{"hours":20}');
        expect(clockLabel(t, { state: 'overdue', unit: 'days', value: 3 })).toBe('compliance.clock_days_overdue|overdue by {days} days|{"days":3}');
        expect(clockLabel(t, { state: 'overdue', unit: 'hours', value: 2 })).toBe('compliance.clock_hours_overdue|overdue by {hours} hours|{"hours":2}');
        expect(clockLabel(t, { state: 'done', completedInDays: 9 })).toBe('compliance.clock_done_in_days|completed in {days} days|{"days":9}');
        expect(clockLabel(t, { state: 'done', completedInDays: null })).toBe('compliance.clock_done|completed|null');
        expect(clockLabel(t, { state: 'none' })).toBe('compliance.clock_none|no open deadline|null');
        expect(clockShortLabel(t, { unit: 'hours', value: 41 })).toBe('compliance.clock_short_hours|{hours} h|{"hours":41}');
        expect(clockShortLabel(t, { unit: 'days', value: 1 })).toBe('compliance.clock_short_days|{days}|{"days":1}');
    });

    it('resolveClock: server state wins, server pct wins, closed states carry no partial bar', () => {
        const base = { dueAt: NOW + 18 * DAY_MS, startedAt: NOW - 12 * DAY_MS, now: NOW };
        expect(resolveClock(base).state).toBe('ok');
        expect(resolveClock({ ...base, state: 'urgent' }).state).toBe('urgent');
        expect(resolveClock({ ...base, pct: 0.75 }).pct).toBe(0.75);
        expect(resolveClock({ ...base, state: 'overdue' }).pct).toBe(1);
        expect(resolveClock({ ...base, state: 'none' }).pct).toBe(0);
        expect(resolveClock({ ...base, state: 'done' }).pct).toBe(1);
    });
});
