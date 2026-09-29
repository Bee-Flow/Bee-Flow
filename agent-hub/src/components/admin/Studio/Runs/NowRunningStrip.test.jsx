import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import NowRunningStrip from './NowRunningStrip';

vi.mock('../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (key, fallback, params) => interpolate(fallback ?? key, params), locale: 'en' }),
}));
const interpolate = (s, params) => String(s).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));

const roll = (over = {}) => ({
    automationId: 'a1', title: 'Weekly digest', kind: 'automation',
    total: 3, status: { success: 3 }, lastRunAt: new Date().toISOString(),
    ...over,
});

describe('NowRunningStrip — the three states never borrow each other\'s look', () => {
    beforeEach(cleanup);

    it('shows a spinner while the first read is in flight', () => {
        render(<NowRunningStrip facets={null} loading />);
        expect(screen.getByTestId('now-running-loading')).toBeTruthy();
        expect(screen.queryByTestId('now-running-empty')).toBeNull();
    });

    it('says it could not read, rather than "nothing is running"', () => {
        // The whole value of a strip somebody glances at is that a quiet one
        // means a quiet organisation. A failed facets read that rendered as
        // "Nothing has run" would spend that credibility silently.
        render(<NowRunningStrip facets={null} loading={false} failed />);
        expect(screen.getByTestId('now-running-unknown')).toBeTruthy();
        expect(screen.queryByTestId('now-running-empty')).toBeNull();
        expect(screen.queryByTestId('now-running-list')).toBeNull();
    });

    it('distinguishes a server without the rollup from a failed read', () => {
        // Same "we do not know" shape, different sentence — one is a problem
        // to fix, the other is an older server behaving as designed.
        render(<NowRunningStrip facets={{ status: {} }} loading={false} failed={false} />);
        const el = screen.getByTestId('now-running-unknown');
        expect(el.textContent).toMatch(/did not report/i);
        expect(el.textContent).not.toMatch(/Could not read/i);
    });

    it('an empty window is its own sentence', () => {
        render(<NowRunningStrip facets={{ automations: [] }} loading={false} />);
        expect(screen.getByTestId('now-running-empty')).toBeTruthy();
        expect(screen.queryByTestId('now-running-unknown')).toBeNull();
    });

    it('keeps the previous lines on screen while a refresh is in flight', () => {
        // `loading` with data present must not blank a strip someone is reading.
        render(<NowRunningStrip facets={{ automations: [roll()] }} loading />);
        expect(screen.getByTestId('now-running-list')).toBeTruthy();
        expect(screen.queryByTestId('now-running-loading')).toBeNull();
    });
});

describe('NowRunningStrip — what a line says', () => {
    beforeEach(cleanup);

    it('draws one line per routine, most urgent first, with its tone on the element', () => {
        render(<NowRunningStrip facets={{ automations: [
            roll({ automationId: 'ok', title: 'Digest', status: { success: 38 }, total: 38 }),
            roll({ automationId: 'bad', title: 'Credit check', status: { error: 1 }, lastErrorClass: 'rate_limit', lastErrorAt: new Date().toISOString() }),
            roll({ automationId: 'wait', title: 'Send quote', status: { awaiting_approval: 1 } }),
        ] }} />);
        const lines = screen.getAllByTestId('now-running-line');
        expect(lines.map(l => l.getAttribute('data-tone'))).toEqual(['error', 'waiting', 'done']);
        expect(lines[0].textContent).toContain('Credit check');
        expect(lines[2].textContent).toContain('38');
    });

    it('names the error by CLASS and never carries a free-text message', () => {
        render(<NowRunningStrip facets={{ automations: [roll({
            status: { error: 1 },
            lastErrorClass: 'rate_limit',
            lastErrorAt: new Date().toISOString(),
            // Whatever a future server sends alongside, this must not reach
            // the screen: in the organisation scope it is someone else's data.
            lastError: 'Could not e-mail jan@example.com',
        })] }} />);
        const line = screen.getByTestId('now-running-line');
        expect(line.textContent).toMatch(/slow down/i);
        expect(line.textContent).not.toContain('jan@example.com');
    });

    it('an unnameable error class still reads as failed', () => {
        render(<NowRunningStrip facets={{ automations: [roll({ status: { error: 2 }, lastErrorClass: 'something_new' })] }} />);
        expect(screen.getByTestId('now-running-line').textContent).toMatch(/failed/i);
    });

    it('a routine with no title says so instead of inventing one', () => {
        render(<NowRunningStrip facets={{ automations: [roll({ title: null })] }} />);
        expect(screen.getByTestId('now-running-line').textContent).toMatch(/without a name/i);
    });

    it('offers the routine only when the screen can navigate', () => {
        const onOpenAutomation = vi.fn();
        render(<NowRunningStrip facets={{ automations: [roll()] }} onOpenAutomation={onOpenAutomation} />);
        fireEvent.click(screen.getByTestId('now-running-open'));
        expect(onOpenAutomation).toHaveBeenCalledWith('a1');
        cleanup();
        render(<NowRunningStrip facets={{ automations: [roll()] }} />);
        expect(screen.queryByTestId('now-running-open')).toBeNull();
    });

    it('says how many routines it is NOT showing', () => {
        const many = Array.from({ length: 9 }, (_, i) => roll({ automationId: `a${i}`, title: `R${i}` }));
        render(<NowRunningStrip facets={{ automations: many, automationsTotal: 40 }} />);
        expect(screen.getByTestId('now-running-more').textContent).toContain('34');
    });
});
