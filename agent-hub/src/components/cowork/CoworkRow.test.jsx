import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import CoworkRow from './CoworkRow';
import { STATUS_TOKENS } from '../shared/statusTokens';

/**
 * The row after CW-03: title + status word on line one, one grey sentence on
 * line two, and nothing else.
 *
 * These tests are about what the row SAYS, not how it is assembled. The status
 * is asserted as a word plus a distinguishable colour (the CW-04 property: a
 * thing working right now and a thing somebody switched off must not look the
 * same in a list of twenty), the meta line as its sentence, and the prompt by
 * its absence.
 */

const item = (over = {}) => ({
    id: 'w1',
    title: 'Weekly digest',
    prompt: 'Summarise the week',
    isActive: true,
    lastStatus: 'success',
    lastRunAt: new Date().toISOString(),
    runCount: 3,
    ...over,
});

/** The status mark: the dot and its word, the only status carrier in the row. */
function statusMark() {
    return document.querySelector('[data-status-key]');
}

/** The colour of the 7px dot inside the mark. */
function dotColour() {
    return statusMark().querySelector('span[aria-hidden="true"]').style.background;
}

describe('CoworkRow — the status', () => {
    beforeEach(cleanup);

    it('says "Running" in the running tone', () => {
        render(<CoworkRow item={item({ lastStatus: 'running' })} selected={false} onSelect={vi.fn()} />);
        const mark = statusMark();
        expect(mark.getAttribute('data-status-key')).toBe('run_status.running');
        expect(mark.textContent).toBe('Running');
        expect(mark.getAttribute('class')).toContain(STATUS_TOKENS.running.solid);
        expect(dotColour()).toBe(STATUS_TOKENS.running.cssVar);
    });

    it('says "Paused" for a switched-off item, in a different tone', () => {
        render(<CoworkRow item={item({ isActive: false, lastStatus: 'idle' })} selected={false} onSelect={vi.fn()} />);
        const mark = statusMark();
        expect(mark.getAttribute('data-status-key')).toBe('run_status.paused');
        expect(mark.textContent).toBe('Paused');
        expect(mark.getAttribute('class')).toContain(STATUS_TOKENS.paused.solid);
        // The neutral rows carry no token of their own; grey is the claim.
        expect(dotColour()).toBe('var(--text-tertiary)');
        expect(dotColour()).not.toBe(STATUS_TOKENS.running.cssVar);
        expect(STATUS_TOKENS.paused.solid).not.toBe(STATUS_TOKENS.running.solid);
    });

    it('says "Failed" out loud rather than leaving it to a red pixel', () => {
        render(<CoworkRow item={item({ lastStatus: 'error' })} selected={false} onSelect={vi.fn()} />);
        expect(statusMark().textContent).toBe('Failed');
        expect(dotColour()).toBe(STATUS_TOKENS.error.cssVar);
    });

    it('gives a screen reader the state as text, not as a colour', () => {
        // The row used to carry the status as one small coloured icon with no
        // word, no aria-label and no title, so "running" and "paused" were
        // indistinguishable without sight (and, after CW-04, still two greys
        // apart for anyone colour-blind). The word is the fix; the dot is
        // decoration and is hidden from the tree.
        render(<CoworkRow item={item({ lastStatus: 'running' })} selected={false} onSelect={vi.fn()} />);
        expect(screen.getByTestId('cowork-row').textContent).toMatch(/Running/);
        expect(statusMark().querySelector('span[aria-hidden="true"]')).not.toBeNull();
    });
});

describe('CoworkRow — the title', () => {
    beforeEach(cleanup);

    it('shows the title', () => {
        render(<CoworkRow item={item()} selected={false} onSelect={vi.fn()} />);
        expect(screen.getByText('Weekly digest')).toBeTruthy();
    });

    it('falls back to "Untitled cowork" for a blank or missing title', () => {
        render(<CoworkRow item={item({ title: '' })} selected={false} onSelect={vi.fn()} />);
        expect(screen.getByText('Untitled cowork')).toBeTruthy();
        cleanup();
        render(<CoworkRow item={item({ title: undefined })} selected={false} onSelect={vi.fn()} />);
        expect(screen.getByText('Untitled cowork')).toBeTruthy();
    });

    it('is one big button — the whole card is a single control', () => {
        render(<CoworkRow item={item()} selected={false} onSelect={vi.fn()} />);
        const row = screen.getByTestId('cowork-row');
        expect(row.tagName).toBe('BUTTON');
        expect(row.getAttribute('type')).toBe('button');
        expect(row.querySelectorAll('button')).toHaveLength(0);
    });

    it('never puts the brief on the row, however short or long it is', () => {
        // The two-line preview turned six items into a wall of text in a
        // 330px column. The brief lives in the detail now.
        render(<CoworkRow item={item({ prompt: 'Summarise the week' })} selected={false} onSelect={vi.fn()} />);
        expect(screen.getByTestId('cowork-row')).not.toHaveTextContent('Summarise the week');
        cleanup();
        render(<CoworkRow item={item({ prompt: '# Heading <b>bold</b>' })} selected={false} onSelect={vi.fn()} />);
        expect(screen.getByTestId('cowork-row')).not.toHaveTextContent('Heading');
    });
});

const NOW = new Date(2026, 8, 6, 12, 0, 0);          // 6 Sep 2026, 12:00 local

/** Tomorrow at 09:00 local, as the server would send it. */
const tomorrowAt9 = () => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
};

const renderRow = (over = {}, props = {}) => {
    const onSelect = vi.fn();
    render(<CoworkRow item={item(over)} selected={false} onSelect={onSelect} {...props} />);
    return { row: screen.getByTestId('cowork-row'), onSelect };
};

/** The one grey line, or null when the row does not draw it. */
const metaLine = () => {
    const p = screen.getByTestId('cowork-row').querySelector('p');
    return p ? p.textContent : null;
};

describe('CoworkRow — the one meta line', () => {
    beforeEach(() => {
        cleanup();
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('states the cadence with its wall clock, and the tally, in one sentence', () => {
        renderRow({ repeatInterval: 'weekdays', timeOfDay: '08:00', lastStatus: 'running', runCount: 42 });
        expect(metaLine()).toBe('Every weekday 08:00 · ran 42 times');
    });

    it('reads the last run instead of the tally once it has settled', () => {
        renderRow({
            repeatInterval: 'weekly',
            timeOfDay: '07:00',
            lastStatus: 'success',
            lastRunAt: new Date(NOW.getTime() - 2 * 86400_000).toISOString(),
            runCount: 12,
        });
        expect(metaLine()).toBe('Every week 07:00 · last run 2d ago');
    });

    it('does not read the previous run out beside a live one', () => {
        // "last run 3h ago" next to "Running" is about the run BEFORE this
        // one — true, and the wrong fact to put there.
        renderRow({
            lastStatus: 'running',
            repeatInterval: 'daily',
            lastRunAt: new Date(NOW.getTime() - 3 * 3600_000).toISOString(),
            runCount: 9,
        });
        expect(metaLine()).toBe('Every day · ran 9 times');
    });

    it('names the weekdays of a days-of-week schedule', () => {
        // 8 Jan 2024 was a Monday — built here independently of the row's own
        // anchor date, so the two have to agree on more than a constant.
        const monday = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2024, 0, 8, 12));
        renderRow({
            repeatInterval: null,
            daysOfWeek: ['mon'],
            timeOfDay: '07:00',
            lastRunAt: null,
            runCount: 0,
        });
        expect(metaLine()).toBe(`${monday} 07:00`);
    });

    it('lists days in week order, not in the order they arrived', () => {
        const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
        const monday = fmt.format(new Date(2024, 0, 8, 12));
        const thursday = fmt.format(new Date(2024, 0, 11, 12));
        renderRow({ repeatInterval: null, daysOfWeek: ['thu', 'mon'], lastRunAt: null, runCount: 0 });
        expect(metaLine()).toBe(`${monday}, ${thursday}`);
    });

    it('states the concrete moment of a one-off that is still coming', () => {
        renderRow({ repeatInterval: null, nextRunAt: tomorrowAt9(), lastRunAt: null, runCount: 0 });
        expect(metaLine()).toMatch(/^Tomorrow at /);
    });

    it('hides the next run of a switched-off item even when the server still has one', () => {
        renderRow({
            repeatInterval: null,
            isActive: false,
            nextRunAt: tomorrowAt9(),
            lastRunAt: null,
            runCount: 0,
        });
        expect(metaLine()).toBeNull();
    });

    it('says "ran once" rather than "ran 1 times"', () => {
        renderRow({ repeatInterval: null, lastStatus: 'running', lastRunAt: null, runCount: 1 });
        expect(metaLine()).toBe('ran once');
    });

    it('leaves the line out entirely when there is nothing to say', () => {
        // Never run, no cadence, nothing scheduled. "ran 0 times" would read
        // as a failure; an absent line reads as "not yet".
        renderRow({ repeatInterval: null, nextRunAt: null, lastRunAt: null, runCount: 0 });
        expect(metaLine()).toBeNull();
    });

    it('echoes an unknown repeat interval raw — that value is data, not copy', () => {
        renderRow({ repeatInterval: 'fortnightly', lastRunAt: null, runCount: 0 });
        expect(metaLine()).toBe('fortnightly');
    });

    it('keeps the whole sentence on one line', () => {
        renderRow({ repeatInterval: 'weekdays', timeOfDay: '08:00', runCount: 42 });
        expect(screen.getByTestId('cowork-row').querySelector('p').className).toContain('truncate');
    });
});

describe('CoworkRow — selection and accessibility', () => {
    beforeEach(cleanup);

    it('lifts the selected row onto a card', () => {
        render(<CoworkRow item={item()} selected onSelect={vi.fn()} />);
        const row = screen.getByTestId('cowork-row');
        expect(row.getAttribute('aria-current')).toBe('true');
        expect(row.style.background).toBe('var(--bg-card)');
        expect(row.style.boxShadow).toBe('var(--shadow-sm)');
    });

    it('leaves an unselected row flat and unannounced', () => {
        const { row } = renderRow();
        expect(row.getAttribute('aria-current')).toBeNull();
        expect(row.style.background).toBe('transparent');
        expect(row.style.boxShadow).toBe('none');
    });

    it('hands the item id back on click, and carries it as a data attribute', () => {
        const { row, onSelect } = renderRow({ id: 'w9' });
        expect(row.getAttribute('data-cowork-id')).toBe('w9');
        fireEvent.click(row);
        expect(onSelect).toHaveBeenCalledWith('w9');
        expect(onSelect).toHaveBeenCalledTimes(1);
    });
});
