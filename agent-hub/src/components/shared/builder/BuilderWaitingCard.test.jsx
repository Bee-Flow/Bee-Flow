import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BuilderWaitingCard from './BuilderWaitingCard';
import { recordTtft } from './timeToFirstToken';
import scopedStorage from '../../../utils/scopedStorage';

// Flipped by the last test only: every visible string must come out of t(),
// so with a t() that returns its key in brackets, nothing readable may remain.
let keyedT = false;
vi.mock('../../../hooks/useTranslation', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useTranslation: () => {
            const real = actual.useTranslation();
            return keyedT ? { ...real, t: (key) => `⟦${key}⟧` } : real;
        },
    };
});

const NOW = 1_700_000_000_000;

const turn = (over = {}) => ({
    sentAt: NOW - 65_000,
    tier: 'fast',
    sessionAt: null,
    pings: 0,
    lastPingAt: null,
    modelId: null,
    roundStartedAt: null,
    promptChars: null,
    firstEventAt: null,
    iter: null,
    local: null,
    providerType: null,
    phase: null,
    progress: null,
    usage: null,
    ...over,
});

// A round mid-prefill on llama-server: 28k-token prompt, 20.1k of it
// remembered from the previous request, 24.4k processed so far.
const PROGRESS = { total: 28_000, cache: 20_100, processed: 24_400, timeMs: 3000, at: NOW };
const readingTurn = (progress = PROGRESS, over = {}) => turn({
    sessionAt: NOW - 64_000, pings: 2, promptChars: 112_000, modelId: 'qwen3.6-35b-a3b',
    local: true, phase: 'reading', progress, ...over,
});

/** Run `fn` with the OS asking for reduced motion; the original matchMedia comes back after. */
function withReducedMotion(fn) {
    const prior = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (q) => ({ matches: /prefers-reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} }),
    });
    try {
        fn();
    } finally {
        if (prior) Object.defineProperty(window, 'matchMedia', prior);
        else delete window.matchMedia;
    }
}

const state = (id) => screen.getByTestId(`waiting-milestone-${id}`).getAttribute('data-state');

describe('BuilderWaitingCard', () => {
    beforeEach(() => {
        localStorage.clear();
        scopedStorage.setCurrentUser('u-wait');
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
        keyedT = false;
    });

    it('is a polite live region with the running clock counted from sentAt', () => {
        render(<BuilderWaitingCard turn={turn()} modelKey="tier:fast" />);
        const card = screen.getByTestId('builder-waiting-card');
        expect(card.getAttribute('role')).toBe('status');
        expect(card.getAttribute('aria-live')).toBe('polite');
        expect(screen.getByText('Waiting for the model')).toBeTruthy();
        expect(screen.getByTestId('waiting-elapsed').textContent).toContain('1m 5s');
    });

    it('flips the milestones on the turn fields, never on a timer', () => {
        const { rerender } = render(<BuilderWaitingCard turn={turn()} modelKey="tier:fast" />);
        expect(state('sent')).toBe('done');
        expect(state('session')).toBe('live');
        expect(state('reading')).toBe('pending');
        expect(state('first')).toBe('pending');
        expect(screen.queryByTestId('waiting-ping-dot')).toBeNull();

        rerender(<BuilderWaitingCard turn={turn({ sessionAt: NOW - 64_000 })} modelKey="tier:fast" />);
        expect(state('session')).toBe('done');
        expect(state('reading')).toBe('live');
        expect(state('first')).toBe('pending');
        expect(screen.getByTestId('waiting-ping-dot')).toBeTruthy();
        expect(screen.getByText('Request sent')).toBeTruthy();
        expect(screen.getByText('Session opened')).toBeTruthy();
        expect(screen.getByText('Model is reading your request')).toBeTruthy();
        expect(screen.getByText('First response')).toBeTruthy();
    });

    it('remounts the heartbeat dot on every ping so its animation replays', () => {
        const live = (pings) => turn({ sessionAt: NOW - 64_000, pings });
        const { rerender } = render(<BuilderWaitingCard turn={live(1)} modelKey="tier:fast" />);
        const first = screen.getByTestId('waiting-ping-dot');
        expect(first.className).toContain('bf-ping-tick');
        expect(screen.getByText('connection alive · 1 heartbeats')).toBeTruthy();

        // Same ping count, other fields moving: the dot stays put.
        rerender(<BuilderWaitingCard turn={live(1)} modelKey="tier:fast" />);
        expect(screen.getByTestId('waiting-ping-dot')).toBe(first);

        rerender(<BuilderWaitingCard turn={live(2)} modelKey="tier:fast" />);
        const second = screen.getByTestId('waiting-ping-dot');
        expect(second).not.toBe(first);
        expect(screen.getByText('connection alive · 2 heartbeats')).toBeTruthy();
    });

    it('with no history: a shimmer bar and the first-time explanation', () => {
        render(<BuilderWaitingCard turn={turn()} modelKey="tier:fast" />);
        const bar = screen.getByTestId('waiting-bar');
        expect(bar.getAttribute('data-mode')).toBe('indeterminate');
        expect(bar.className).toContain('bf-wait-bar');
        expect(screen.queryByTestId('waiting-bar-fill')).toBeNull();
        expect(screen.getByTestId('waiting-expectation').textContent)
            .toBe('Local models take a few minutes to read the request the first time');
    });

    it('with history: a bar filling towards the median and "usually about"', () => {
        // Median of these is 130 s; 65 s elapsed → half way.
        for (const ms of [120_000, 130_000, 140_000]) recordTtft('qwen3-27b', ms);
        render(<BuilderWaitingCard turn={turn({ modelId: 'qwen3-27b' })} modelKey="qwen3-27b" />);
        const bar = screen.getByTestId('waiting-bar');
        expect(bar.getAttribute('data-mode')).toBe('determinate');
        expect(bar.className).not.toContain('bf-wait-bar');
        const fill = screen.getByTestId('waiting-bar-fill');
        expect(fill.style.width).toBe('50%');
        expect(fill.style.transition).toBe('width 1s linear');
        expect(screen.getByTestId('waiting-expectation').textContent).toBe('Usually about 2m 10s');
    });

    it('admits it when the wait has outrun the median', () => {
        for (const ms of [40_000, 40_000, 40_000]) recordTtft('tier:fast', ms);
        render(<BuilderWaitingCard turn={turn()} modelKey="tier:fast" />);
        expect(screen.getByTestId('waiting-bar').getAttribute('data-over')).toBe('true');
        expect(screen.getByTestId('waiting-bar-fill').style.width).toBe('96%');
        expect(screen.getByTestId('waiting-expectation').textContent).toBe('Taking longer than usual (40s)');
    });

    it('says how much it is reading once round_start named the prompt size', () => {
        render(<BuilderWaitingCard turn={turn({ promptChars: 112_000 })} modelKey="tier:fast" />);
        expect(screen.getByTestId('waiting-prompt-size').textContent).toContain('Reading about 28k tokens');
    });

    it('keeps the clock and the estimate alive on the one-second tick', () => {
        for (const ms of [100_000]) recordTtft('tier:fast', ms);
        render(<BuilderWaitingCard turn={turn({ sentAt: NOW - 10_000 })} modelKey="tier:fast" />);
        expect(screen.getByTestId('waiting-elapsed').textContent).toContain('10s');
        expect(screen.getByTestId('waiting-bar-fill').style.width).toBe('10%');
        act(() => { vi.advanceTimersByTime(20_000); });
        expect(screen.getByTestId('waiting-elapsed').textContent).toContain('30s');
        expect(screen.getByTestId('waiting-bar-fill').style.width).toBe('30%');
    });

    it('falls back to startedAt when there is no turn object at all', () => {
        render(<BuilderWaitingCard turn={null} startedAt={NOW - 5_000} modelKey="tier:fast" />);
        expect(screen.getByTestId('waiting-elapsed').textContent).toContain('5s');
        expect(state('session')).toBe('live');
    });

    it('real progress: a determinate bar at processed/total, gliding 600 ms between chunks', () => {
        render(<BuilderWaitingCard turn={readingTurn()} modelKey="qwen3.6-35b-a3b" />);
        const bar = screen.getByTestId('waiting-bar');
        expect(bar.getAttribute('data-mode')).toBe('determinate');
        expect(bar.getAttribute('data-source')).toBe('progress');
        expect(bar.className).not.toContain('bf-wait-bar');
        const fill = screen.getByTestId('waiting-bar-fill');
        expect(fill.style.width).toBe('87%');                 // 24 400 / 28 000
        expect(fill.style.transition).toBe('width 600ms linear');
        // The accent goes through --bf-accent so the App Studio editor (whose
        // --accent-primary is grey) can hand the card its own; the routine canvas
        // sets none and falls back to --accent as before.
        expect(fill.style.background).toBe('var(--bf-accent, var(--accent))');
    });

    it('real progress: the remembered share is its own lighter segment at the start of the bar', () => {
        render(<BuilderWaitingCard turn={readingTurn()} modelKey="qwen3.6-35b-a3b" />);
        const cache = screen.getByTestId('waiting-bar-cache');
        expect(cache.style.width).toBe('72%');                // 20 100 / 28 000
        expect(cache.style.background).not.toBe(screen.getByTestId('waiting-bar-fill').style.background);
        expect(cache.style.background).toContain('var(--accent)');
        // Layered on top of the fill's start: same left edge, no offset.
        expect(cache.className).toContain('left-0');
        expect(screen.getByTestId('waiting-bar-fill').className).toContain('left-0');
    });

    it('real progress: "Reading X of Y tokens · N already remembered" replaces the size estimate; the expectation stays', () => {
        for (const ms of [120_000, 130_000, 140_000]) recordTtft('qwen3.6-35b-a3b', ms);
        render(<BuilderWaitingCard turn={readingTurn()} modelKey="qwen3.6-35b-a3b" />);
        expect(screen.getByTestId('waiting-progress').textContent).toBe(' · Reading 24.4k of 28.0k tokens · 20.1k already remembered from last time');
        expect(screen.getByTestId('waiting-remembered').textContent).toBe(' · 20.1k already remembered from last time');
        expect(screen.queryByTestId('waiting-prompt-size')).toBeNull();
        // The learned line is context, not competition: still there, and the
        // bar is the real one rather than the history one.
        expect(screen.getByTestId('waiting-expectation').textContent).toBe('Usually about 2m 10s');
        expect(screen.getByTestId('waiting-bar').getAttribute('data-source')).toBe('progress');
        expect(screen.getByTestId('waiting-bar').getAttribute('data-over')).toBeNull();
    });

    it('real progress without a cache hit: no remembered segment and no remembered words', () => {
        render(<BuilderWaitingCard turn={readingTurn({ ...PROGRESS, cache: 0, processed: 1_200 })} modelKey="qwen3.6-35b-a3b" />);
        expect(screen.queryByTestId('waiting-bar-cache')).toBeNull();
        expect(screen.queryByTestId('waiting-remembered')).toBeNull();
        expect(screen.getByTestId('waiting-progress').textContent).toBe(' · Reading 1.2k of 28.0k tokens');
        expect(screen.getByTestId('waiting-bar-fill').style.width).toBe('4%');
    });

    it('at nine tenths of the prompt the reading row says "Writing the first step…" instead of counting heartbeats', () => {
        // 24.4k of 28k is 87 %: still heartbeats.
        const { rerender } = render(<BuilderWaitingCard turn={readingTurn()} modelKey="qwen3.6-35b-a3b" />);
        expect(state('reading')).toBe('live');
        expect(screen.getByText('connection alive · 2 heartbeats')).toBeTruthy();
        expect(screen.queryByText('Writing the first step…')).toBeNull();
        // 26k of 28k is 93 %: the answer is next.
        rerender(<BuilderWaitingCard turn={readingTurn({ ...PROGRESS, processed: 26_000 })} modelKey="qwen3.6-35b-a3b" />);
        expect(screen.getByText('Writing the first step…')).toBeTruthy();
        expect(screen.queryByText('connection alive · 2 heartbeats')).toBeNull();
        expect(state('reading')).toBe('live');
        expect(state('first')).toBe('pending');
        // Still a live region, still the heartbeat dot keyed on pings.
        expect(screen.getByTestId('builder-waiting-card').getAttribute('role')).toBe('status');
        expect(screen.getByTestId('waiting-ping-dot')).toBeTruthy();
    });

    it('clamps: processed past the total fills to 100 %, never beyond; a nonsense total falls back to the estimate', () => {
        const { rerender } = render(<BuilderWaitingCard turn={readingTurn({ total: 1000, cache: 5000, processed: 9000 })} modelKey="q" />);
        expect(screen.getByTestId('waiting-bar-fill').style.width).toBe('100%');
        expect(screen.getByTestId('waiting-bar-cache').style.width).toBe('100%');
        expect(screen.getByTestId('waiting-progress').textContent).toBe(' · Reading 1.0k of 1.0k tokens · 1.0k already remembered from last time');
        rerender(<BuilderWaitingCard turn={readingTurn({ total: 0, cache: 0, processed: 0 })} modelKey="q" />);
        expect(screen.queryByTestId('waiting-progress')).toBeNull();
        expect(screen.getByTestId('waiting-prompt-size').textContent).toContain('Reading about 28k tokens');
        expect(screen.getByTestId('waiting-bar').getAttribute('data-mode')).toBe('indeterminate');
    });

    it('a new round resets progress to null and the card is back on the estimate — nothing lingers', () => {
        const { rerender } = render(<BuilderWaitingCard turn={readingTurn()} modelKey="q" />);
        expect(screen.getByTestId('waiting-progress')).toBeTruthy();
        rerender(<BuilderWaitingCard turn={readingTurn(null)} modelKey="q" />);
        expect(screen.queryByTestId('waiting-progress')).toBeNull();
        expect(screen.queryByTestId('waiting-bar-cache')).toBeNull();
        expect(screen.getByTestId('waiting-prompt-size')).toBeTruthy();
    });

    it('under reduced motion the bars still show the figure but do not slide', () => {
        withReducedMotion(() => {
            const { rerender } = render(<BuilderWaitingCard turn={readingTurn()} modelKey="qwen3.6-35b-a3b" />);
            const fill = screen.getByTestId('waiting-bar-fill');
            expect(fill.style.width).toBe('87%');
            expect(fill.style.transition).toBe('none');
            // The learned bar too.
            for (const ms of [130_000]) recordTtft('tier:fast', ms);
            rerender(<BuilderWaitingCard turn={turn()} modelKey="tier:fast" />);
            expect(screen.getByTestId('waiting-bar').getAttribute('data-source')).toBe('history');
            expect(screen.getByTestId('waiting-bar-fill').style.transition).toBe('none');
        });
    });

    it('the progress copy goes through t() too — a keyed translator leaves only keys', () => {
        keyedT = true;
        render(<BuilderWaitingCard turn={readingTurn({ ...PROGRESS, processed: 26_000 })} modelKey="qwen3.6-35b-a3b" />);
        const text = screen.getByTestId('builder-waiting-card').textContent;
        expect(text).toContain('⟦routines.builder.wait.progress⟧');
        expect(text).toContain('⟦routines.builder.wait.remembered⟧');
        expect(text).toContain('⟦routines.builder.wait.writing⟧');
        expect(text).not.toContain('⟦routines.builder.wait.prompt_size⟧');
        expect(text).not.toContain('⟦routines.builder.wait.heartbeats⟧');
        const rest = text
            .replace(/\d+\s*[hms](?![a-z])/g, '')
            .replace(/⟦[^⟧]*⟧/g, '')
            .replace(/[\d\s·%()]/g, '');
        expect(rest).toBe('');
    });

    it('puts every string through t() — nothing readable is left with a keyed translator', () => {
        keyedT = true;
        for (const ms of [40_000]) recordTtft('tier:fast', ms);
        render(<BuilderWaitingCard turn={turn({ sessionAt: NOW - 64_000, pings: 3, promptChars: 20_000 })} modelKey="tier:fast" />);
        const text = screen.getByTestId('builder-waiting-card').textContent;
        expect(text).toContain('⟦routines.builder.wait.title⟧');
        expect(text).toContain('⟦routines.builder.wait.longer⟧');
        expect(text).toContain('⟦routines.builder.wait.prompt_size⟧');
        // Strip the clock first (digits + h/m/s, while the keyed tokens still
        // separate it from the badge numbers), then the tokens, then digits
        // and punctuation. Whatever is left is English that bypassed t().
        const rest = text
            .replace(/\d+\s*[hms](?![a-z])/g, '')
            .replace(/⟦[^⟧]*⟧/g, '')
            .replace(/[\d\s·%()]/g, '');
        expect(rest).toBe('');
    });
});
