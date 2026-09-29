import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import CanvasSouthBar from './CanvasSouthBar';
import { describeToolCall } from '../chat/toolCallDisplay';
import { nodeTypeLabel } from './nodeDefs';

/**
 * The build banner: the south bar's second precedence slot, and the lock
 * notice that replaced the amber "AI is editing" chip.
 *
 * What is pinned: where it sits in the precedence (under the run banner, over
 * the selection bar), that its verb is the activity row's exact words, that a
 * refusal is shown briefly and in the warning tone rather than as an error on a
 * card, that plan progress appears only when a plan exists, that the Follow
 * button is never a dead control, and that the ending lingers for four seconds
 * and then hands the bar back to the gesture hint.
 *
 * Then the two strips to the right of the verb: the plan strip ("Plan 1/3 ·
 * <next to-do>") and the engine line (flow/engineLine.js — model, on this
 * machine or not, live reading progress, last-round rates). The wording of
 * the engine line is pinned in engineLine.test.js; here it is that the bar
 * renders it, only while building, never claiming "on this machine" for a
 * cloud model, and in a span that gives way before the banner wraps.
 */
const T0 = new Date('2026-09-10T10:00:00Z').getTime();

const cue = (over = {}) => ({
    running: true, phase: 'building', startedAt: T0 - 42_000, lastCall: null, narration: null,
    todos: [], finalizedId: null, aborted: null, stepCount: 0, ...over,
});
const focus = (over = {}) => ({
    stepId: 's1', label: 'Ask for approval', done: 1, total: 3,
    state: 'running', startedAt: null, awaitingForm: false, ...over,
});
// The same shape BuildTab derives: tc.name plus describeToolCall's row.
const callFor = (tc) => ({ name: tc.name, ...describeToolCall(tc) });

describe('CanvasSouthBar — the build banner', () => {
    beforeEach(() => {
        cleanup();
        vi.useFakeTimers();
        vi.setSystemTime(T0);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('renders nothing of the build banner without a cue', () => {
        render(<CanvasSouthBar />);
        expect(screen.queryByTestId('canvas-build-banner')).toBeNull();
        expect(screen.getByTestId('canvas-hint')).toBeTruthy();
    });

    it('the run banner beats the build banner — a live run is the more urgent fact', () => {
        render(<CanvasSouthBar runFocus={focus()} buildCue={cue()} />);
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
        expect(screen.queryByTestId('canvas-build-banner')).toBeNull();
    });

    it('the build banner beats the selection bar and the hint — never two at once', () => {
        render(<CanvasSouthBar buildCue={cue()} editable selectedCount={2} onDeleteSelection={vi.fn()} />);
        expect(screen.getByTestId('canvas-build-banner')).toBeTruthy();
        expect(screen.queryByTestId('canvas-selection-bar')).toBeNull();
        expect(screen.queryByTestId('canvas-hint')).toBeNull();
    });

    it('reads "Building · <elapsed> · <verb>" with the verb being describeToolCall\'s exact words', () => {
        const tc = { name: 'builder_add_http_request', arguments: {}, result: { added: { id: 's2', type: 'http_request', label: 'Fetch invoices' } } };
        const lastCall = callFor(tc);
        render(<CanvasSouthBar buildCue={cue({ lastCall })} />);
        const banner = screen.getByTestId('canvas-build-banner');
        expect(banner.textContent).toContain('Building');
        expect(screen.getByTestId('canvas-build-elapsed').textContent).toContain('42s');
        expect(screen.getByTestId('canvas-build-verb').textContent).toBe(` · ${lastCall.title} · Fetch invoices`);
        // No plan → no "step n of N" invented from nothing.
        expect(screen.queryByTestId('canvas-build-plan')).toBeNull();
    });

    it('a builder_add_steps batch reads "Added 6 steps · <what each is>"', () => {
        const added = [
            { id: 'a', type: 'http_request' }, { id: 'b', type: 'ai_step' }, { id: 'c', type: 'integration_action', tool: 'gmail_send' },
            { id: 'd', type: 'set' }, { id: 'e', type: 'condition' }, { id: 'f', type: 'notification' },
        ];
        const lastCall = callFor({ name: 'builder_add_steps', arguments: {}, result: { added, idMap: {} } });
        render(<CanvasSouthBar buildCue={cue({ lastCall })} />);
        const expected = [nodeTypeLabel('http_request'), nodeTypeLabel('ai_step'), 'Gmail', nodeTypeLabel('set'), nodeTypeLabel('condition'), nodeTypeLabel('notification')].join(' · ');
        expect(screen.getByTestId('canvas-build-verb').textContent).toBe(` · Added 6 steps · ${expected}`);
    });

    it('keeps the clock ticking while the build runs', () => {
        render(<CanvasSouthBar buildCue={cue({ startedAt: T0 })} />);
        expect(screen.getByTestId('canvas-build-elapsed').textContent).toContain('0s');
        act(() => { vi.advanceTimersByTime(3_000); });
        expect(screen.getByTestId('canvas-build-elapsed').textContent).toContain('3s');
    });

    it('a refused call reads "Skipped: <reason>" in the warning tone, for four seconds, then the verb returns', () => {
        const reason = 'The app "hubspot" is not connected for this organisation, so its actions cannot be used here at all';
        const lastCall = callFor({ name: 'builder_add_integration_action', arguments: {}, result: { error: reason } });
        render(<CanvasSouthBar buildCue={cue({ lastCall })} />);
        const verb = screen.getByTestId('canvas-build-verb');
        expect(verb.textContent).toContain('Skipped: ');
        expect(verb.textContent).not.toContain(reason);          // truncated…
        expect(verb.textContent.length).toBeLessThanOrEqual(' · Skipped: '.length + 72);
        expect(verb.textContent.endsWith('…')).toBe(true);
        expect(verb.style.color).toBe('var(--warning)');
        act(() => { vi.advanceTimersByTime(4_100); });
        const after = screen.getByTestId('canvas-build-verb');
        expect(after.textContent).not.toContain('Skipped');
        expect(after.textContent).toContain(lastCall.title);
        expect(after.style.color).toBe('');
    });

    it('the same refused call re-rendered does not restart the four seconds; a new refusal does', () => {
        const first = callFor({ name: 'builder_update_step', arguments: {}, result: { error: 'no such step' } });
        const { rerender } = render(<CanvasSouthBar buildCue={cue({ lastCall: first })} />);
        act(() => { vi.advanceTimersByTime(3_000); });
        // A narration update rebuilds the cue but keeps the call object.
        rerender(<CanvasSouthBar buildCue={cue({ lastCall: first, narration: 'checking the step ids' })} />);
        act(() => { vi.advanceTimersByTime(1_100); });
        expect(screen.getByTestId('canvas-build-verb').textContent).not.toContain('Skipped');
        const second = callFor({ name: 'builder_update_step', arguments: {}, result: { error: 'still no such step' } });
        rerender(<CanvasSouthBar buildCue={cue({ lastCall: second })} />);
        expect(screen.getByTestId('canvas-build-verb').textContent).toContain('Skipped: still no such step');
    });

    it('says "Reviewing the routine…" in the reviewing phase instead of the past-tense verb', () => {
        const lastCall = callFor({ name: 'builder_summarise', arguments: {}, result: { ok: true } });
        render(<CanvasSouthBar buildCue={cue({ lastCall, phase: 'reviewing' })} />);
        expect(screen.getByTestId('canvas-build-verb').textContent).toBe(' · Reviewing the routine…');
    });

    it('shows "Plan done/total · <next to-do>" only when a plan exists, quoting the first undone todo', () => {
        const todos = [{ text: 'Fetch the invoices', done: true }, { text: 'Summarise each one', done: false }, { text: 'Send the digest', done: false }];
        const { rerender } = render(<CanvasSouthBar buildCue={cue({ todos })} />);
        expect(screen.getByTestId('canvas-build-plan').textContent).toBe(' · Plan 1/3 · Summarise each one');
        expect(screen.getByTestId('canvas-build-plan-next').textContent).toBe(' · Summarise each one');
        // Everything done → the count alone; there is no next to-do to quote.
        rerender(<CanvasSouthBar buildCue={cue({ todos: todos.map(x => ({ ...x, done: true })) })} />);
        expect(screen.getByTestId('canvas-build-plan').textContent).toBe(' · Plan 3/3');
        expect(screen.queryByTestId('canvas-build-plan-next')).toBeNull();
        rerender(<CanvasSouthBar buildCue={cue({ todos: [] })} />);
        expect(screen.queryByTestId('canvas-build-plan')).toBeNull();
    });

    it('cuts a long to-do at 48 characters and drops it when the verb already says the same words', () => {
        const long = 'Look up every open invoice in the accounting system and match it against the bank statement lines';
        const { rerender } = render(<CanvasSouthBar buildCue={cue({ todos: [{ text: long, done: false }] })} />);
        const next = screen.getByTestId('canvas-build-plan-next').textContent;
        expect(next.endsWith('…')).toBe(true);
        expect(next.length).toBeLessThanOrEqual(' · '.length + 48);
        expect(next).toContain('Look up every open invoice');
        // The verb (describeToolCall's words) already quotes the to-do: no stutter.
        const lastCall = callFor({ name: 'builder_add_http_request', arguments: {}, result: { added: { id: 's2', type: 'http_request', label: 'Summarise each one' } } });
        rerender(<CanvasSouthBar buildCue={cue({ lastCall, todos: [{ text: 'Summarise each one', done: false }, { text: 'x', done: false }] })} />);
        expect(screen.getByTestId('canvas-build-verb').textContent).toContain('Summarise each one');
        expect(screen.getByTestId('canvas-build-plan').textContent).toBe(' · Plan 0/2');
        expect(screen.queryByTestId('canvas-build-plan-next')).toBeNull();
    });

    it('the plan strip sits before the engine line', () => {
        const todos = [{ text: 'Fetch the invoices', done: false }];
        const engine = { modelId: 'qwen3.6-35b-a3b', local: true, providerType: 'llamacpp', readTokPerSec: null, writeTokPerSec: null };
        render(<CanvasSouthBar buildCue={cue({ todos, engine, turn: { phase: 'reading', progress: null } })} />);
        const text = screen.getByTestId('canvas-build-banner').textContent;
        expect(text.indexOf('Plan 0/1')).toBeGreaterThan(-1);
        expect(text.indexOf('Plan 0/1')).toBeLessThan(text.indexOf('On this machine'));
    });

    it('draws no engine line without engine facts, and none once the build has ended', () => {
        const { rerender } = render(<CanvasSouthBar buildCue={cue()} />);
        expect(screen.queryByTestId('canvas-build-engine')).toBeNull();
        rerender(<CanvasSouthBar buildCue={cue({ engine: null, turn: { phase: 'reading', progress: { total: 100, cache: 0, processed: 10 } } })} />);
        // Progress alone (no engine) still says something true: the reading figure.
        expect(screen.getByTestId('canvas-build-engine').textContent).toBe('reading 10 of 100 tokens');
        const engine = { modelId: 'qwen3.6-35b-a3b', local: true, readTokPerSec: 1450, writeTokPerSec: 23 };
        rerender(<CanvasSouthBar buildCue={cue({ engine })} />);
        expect(screen.getByTestId('canvas-build-engine')).toBeTruthy();
        rerender(<CanvasSouthBar buildCue={cue({ engine, running: false, finalizedId: 'auto_1', stepCount: 3 })} />);
        expect(screen.getByTestId('canvas-build-farewell')).toBeTruthy();
        expect(screen.queryByTestId('canvas-build-engine')).toBeNull();
    });

    it('a local model: the "On this machine" pill, the model name, "nothing sent outside"', () => {
        const engine = { modelId: 'local/qwen/qwen3.6-35b-a3b', local: true, providerType: 'llamacpp', readTokPerSec: null, writeTokPerSec: null };
        render(<CanvasSouthBar buildCue={cue({ engine, turn: { phase: 'reading', progress: null } })} />);
        const line = screen.getByTestId('canvas-build-engine');
        expect(screen.getByTestId('canvas-build-engine-local').textContent).toBe('On this machine');
        expect(line.textContent).toBe('On this machineqwen3.6-35b-a3b · nothing sent outside');
        expect(line.getAttribute('data-local')).toBe('');
        // The full id is one hover away; the bar shows the short name.
        expect(line.getAttribute('title')).toBe('local/qwen/qwen3.6-35b-a3b');
        // Reading without progress adds nothing — the elapsed clock is the fact.
        expect(line.textContent).not.toContain('reading');
        expect(line.textContent).not.toContain('tok/s');
    });

    it('a cloud model: the name only — no pill, and never "nothing sent outside"', () => {
        for (const local of [false, null, undefined]) {
            cleanup();
            const engine = { modelId: 'claude-haiku-4-5', local, providerType: 'claude', readTokPerSec: null, writeTokPerSec: null };
            render(<CanvasSouthBar buildCue={cue({ engine, turn: { phase: 'writing', progress: null } })} />);
            const line = screen.getByTestId('canvas-build-engine');
            expect(screen.queryByTestId('canvas-build-engine-local')).toBeNull();
            expect(line.getAttribute('data-local')).toBeNull();
            expect(line.textContent).toBe('claude-haiku-4-5 · writing…');
            expect(line.textContent).not.toContain('nothing sent outside');
            expect(line.textContent).not.toContain('On this machine');
        }
    });

    it('while reading with progress: "reading X of Y tokens · N remembered", and no stale rates', () => {
        const engine = { modelId: 'qwen3.6-35b-a3b', local: true, readTokPerSec: 1450, writeTokPerSec: 23 };
        const turn = { phase: 'reading', progress: { total: 28_000, cache: 20_100, processed: 24_400, timeMs: 3000, at: T0 } };
        render(<CanvasSouthBar buildCue={cue({ engine, turn })} />);
        const line = screen.getByTestId('canvas-build-engine');
        expect(line.textContent).toBe('On this machineqwen3.6-35b-a3b · nothing sent outside · reading 24.4k of 28.0k tokens · 20.1k remembered');
        expect(line.getAttribute('title')).toBe('qwen3.6-35b-a3b');
    });

    it('while writing, and after a round: "writing…" then the last-round rates, with the measured-on title', () => {
        const engine = { modelId: 'qwen3.6-35b-a3b', local: true, readTokPerSec: 1450, writeTokPerSec: 23 };
        const { rerender } = render(<CanvasSouthBar buildCue={cue({ engine, turn: { phase: 'writing', progress: null } })} />);
        const line = screen.getByTestId('canvas-build-engine');
        expect(line.textContent).toBe('On this machineqwen3.6-35b-a3b · nothing sent outside · writing… · reads 1.5k tok/s · writes 23 tok/s');
        expect(line.getAttribute('title')).toBe('qwen3.6-35b-a3b · measured on the last model call');
        rerender(<CanvasSouthBar buildCue={cue({ engine, turn: { phase: null, progress: null } })} />);
        expect(screen.getByTestId('canvas-build-engine').textContent).toBe('On this machineqwen3.6-35b-a3b · nothing sent outside · reads 1.5k tok/s · writes 23 tok/s');
    });

    it('the engine line gives way before the banner wraps: min-w-0 truncate, hidden on a narrow viewport, tertiary 11px', () => {
        const engine = { modelId: 'qwen3.6-35b-a3b', local: true, readTokPerSec: 1450, writeTokPerSec: 23 };
        render(<CanvasSouthBar buildCue={cue({ engine })} />);
        const cls = screen.getByTestId('canvas-build-engine').className;
        for (const c of ['min-w-0', 'truncate', 'hidden', 'lg:block', 'text-[11px]', 'tabular-nums', 'text-[var(--text-tertiary)]']) {
            expect(cls.split(/\s+/)).toContain(c);
        }
        // The dot owns `--accent`; the pill borrows nothing from it.
        expect(screen.getByTestId('canvas-build-engine-local').className).not.toContain('accent');
    });

    it('offers "Follow the build" only while the camera is held AND a handler exists', () => {
        const onFollow = vi.fn();
        const { rerender } = render(<CanvasSouthBar buildCue={cue()} following={false} onFollow={onFollow} />);
        fireEvent.click(screen.getByTestId('canvas-build-follow'));
        expect(onFollow).toHaveBeenCalledTimes(1);
        rerender(<CanvasSouthBar buildCue={cue()} following onFollow={onFollow} />);
        expect(screen.queryByTestId('canvas-build-follow')).toBeNull();
        // Never a dead control.
        rerender(<CanvasSouthBar buildCue={cue()} following={false} onFollow={null} />);
        expect(screen.queryByTestId('canvas-build-follow')).toBeNull();
    });

    it('after the stream ends: "Built · n steps · <duration>" for four seconds, then the hint', () => {
        const startedAt = T0 - 102_000;
        const { rerender } = render(<CanvasSouthBar buildCue={cue({ startedAt, stepCount: 8 })} />);
        rerender(<CanvasSouthBar buildCue={cue({ startedAt, stepCount: 8, running: false, finalizedId: 'auto_1' })} />);
        const farewell = screen.getByTestId('canvas-build-farewell');
        expect(farewell.textContent).toBe('Built · 8 steps · 1m 42s');
        expect(screen.queryByTestId('canvas-build-follow')).toBeNull();
        // The duration is frozen at the ending, not "how long ago".
        act(() => { vi.advanceTimersByTime(2_000); });
        expect(screen.getByTestId('canvas-build-farewell').textContent).toBe('Built · 8 steps · 1m 42s');
        act(() => { vi.advanceTimersByTime(2_100); });
        expect(screen.queryByTestId('canvas-build-banner')).toBeNull();
        expect(screen.getByTestId('canvas-hint')).toBeTruthy();
    });

    it('a stream that ends without finalizing reads "Stopped — draft saved"', () => {
        const { rerender } = render(<CanvasSouthBar buildCue={cue()} />);
        rerender(<CanvasSouthBar buildCue={cue({ running: false, aborted: { reason: 'max_iterations' } })} />);
        expect(screen.getByTestId('canvas-build-farewell').textContent).toBe('Stopped — draft saved');
    });

    it('a new build starting during the farewell replaces it at once', () => {
        const { rerender } = render(<CanvasSouthBar buildCue={cue()} />);
        rerender(<CanvasSouthBar buildCue={cue({ running: false, finalizedId: 'auto_1', stepCount: 3 })} />);
        expect(screen.getByTestId('canvas-build-farewell')).toBeTruthy();
        rerender(<CanvasSouthBar buildCue={cue({ startedAt: T0 })} />);
        expect(screen.queryByTestId('canvas-build-farewell')).toBeNull();
        expect(screen.getByTestId('canvas-build-banner').textContent).toContain('Building');
    });

    it('mounting with no build in progress shows no farewell — nothing ended', () => {
        render(<CanvasSouthBar buildCue={cue({ running: false, finalizedId: 'auto_1' })} />);
        expect(screen.queryByTestId('canvas-build-banner')).toBeNull();
        expect(screen.getByTestId('canvas-hint')).toBeTruthy();
    });
});
