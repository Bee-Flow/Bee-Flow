import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repeatingApi } from '../../../../../api/queries/automation/repeating';
import type { ScanEventHandler, ScanResult, ScanSources } from '../../../../../api/queries/automation/repeating';
import { queryWrapper } from '@/test/queryWrapper';
import useRepeatingScan, { IDLE_RUN, finalResult, reduceRun, scanError, viewerTimeZone } from './useRepeatingScan';
import type { RunState } from './useRepeatingScan';

const SOURCES: ScanSources = {
    windowDays: 90,
    groups: [
        { id: 'mail', kind: 'live', connected: true, apps: [{ id: 'gmail', label: 'Gmail', connected: true }] },
        { id: 'calendar', kind: 'stored', connected: false, apps: [] },
        { id: 'files', kind: 'live', connected: true, apps: [{ id: 'nextcloud', label: 'Files', connected: true }] },
        { id: 'beeflow', kind: 'stored', connected: true, apps: [] },
    ],
};

const PATTERN = {
    kind: 'mail_template', signature: 'sig-1', cadence: { kind: 'weekly' }, occurrences: 6, windowDays: 90,
    weekdayHistogram: [0, 6, 0, 0, 0, 0, 0], minutesPerMonth: [10, 20], apps: ['gmail'], reasons: [], confidence: 'normal',
};
const lastScan = (over: Partial<ScanResult> = {}): ScanResult => ({
    suggestions: [{ id: 's1', title: 'Invoice to sheet', pattern: null }],
    summary: null, reason: null, scannedAt: new Date().toISOString(), cached: true, mode: 'patterns', ...over,
});

type StreamImpl = (body: unknown, onEvent: ScanEventHandler, signal?: AbortSignal) => Promise<void>;
const drive = (frames: Array<[string, unknown]>): StreamImpl => async (_b, onEvent) => { for (const [e, d] of frames) onEvent(e, d); };

function setup({ last = null as ScanResult | null, undoMs = 30, post = (): Promise<void> => Promise.resolve() } = {}) {
    vi.spyOn(repeatingApi, 'fetchScanSources').mockResolvedValue(SOURCES);
    vi.spyOn(repeatingApi, 'fetchLastScan').mockResolvedValue(last);
    const postFeedback = vi.spyOn(repeatingApi, 'postFeedback').mockImplementation(post);
    const stream = vi.spyOn(repeatingApi, 'streamPatternScan');
    const view = renderHook(() => useRepeatingScan({ undoMs }), { wrapper: queryWrapper() });
    return { view, postFeedback, stream };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('reduceRun', () => {
    const run = (actions: Parameters<typeof reduceRun>[1][], from: RunState = IDLE_RUN) => actions.reduce(reduceRun, from);

    it('starts clean and tracks phases, sources, counts and named patterns', () => {
        const s = run([
            { type: 'start', mode: 'patterns' },
            { type: 'event', event: 'phase', data: { phase: 'collecting' } },
            { type: 'event', event: 'source_step', data: { source: 'mail', app: 'gmail', status: 'start' } },
            { type: 'event', event: 'source_step', data: { source: 'mail', app: 'gmail', status: 'done', events: 40, piiCategories: ['Person'] } },
            { type: 'event', event: 'stats', data: { events: 40, templates: 3, candidates: 2 } },
            { type: 'event', event: 'suggestion', data: { suggestion: { id: 'p1', title: 'One' } } },
            { type: 'event', event: 'suggestion', data: { id: 'p1', title: 'One again' } },
        ]);
        expect(s.scanning).toBe(true);
        expect(s.phase).toBe('collecting');
        expect(s.steps).toEqual([{ key: 'mail:gmail', source: 'mail', app: 'gmail', status: 'done', events: 40, reason: null, piiCategories: ['Person'] }]);
        expect(s.stats).toEqual({ events: 40, templates: 3, candidates: 2 });
        expect(s.streamed.map(x => x.title)).toEqual(['One']);
    });

    it('reads the ideas scan_step frames, a refusal included', () => {
        const s = run([
            { type: 'start', mode: 'ideas' },
            { type: 'event', event: 'scan_step', data: { tool: 'gmail_search', integration: 'gmail', phase: 'done', ok: false, reason: 'shield' } },
        ]);
        expect(s.steps[0]).toMatchObject({ key: 'gmail_search', app: 'gmail', status: 'skipped', reason: 'shield' });
    });

    it('ends, fails, cools down and stops without forgetting the error', () => {
        expect(run([{ type: 'start', mode: 'patterns' }, { type: 'event', event: 'error', data: { error: 'x' } }, { type: 'end' }])).toMatchObject({ scanning: false, error: 'x' });
        expect(run([{ type: 'start', mode: 'patterns' }, { type: 'stop' }])).toMatchObject({ scanning: false, stopped: true });
        expect(run([{ type: 'limit', until: 5 }]).rateLimitedUntil).toBe(5);
    });
});

describe('scanError and finalResult', () => {
    it('turns a 429 or a "Retry in" message into a cooldown, anything else into a failure', () => {
        expect(scanError(Object.assign(new Error('slow down'), { status: 429 }), 'g')).toMatchObject({ type: 'limit' });
        const limited = scanError(new Error('Retry in ~20s'), 'g');
        expect(limited.type).toBe('limit');
        expect(scanError(new Error('boom'), 'g')).toEqual({ type: 'fail', error: 'boom' });
        expect(scanError(null, 'generic')).toEqual({ type: 'fail', error: 'generic' });
    });

    it('trusts done, falls back to the streamed patterns, and stamps what was scanned', () => {
        const body = { mode: 'patterns' as const, sources: ['mail'], focus: 'invoices' };
        const streamed = [{ id: 'p1', title: 'Streamed' }];
        expect(finalResult({ suggestions: [{ id: 'd1', title: 'Done' }] }, streamed, body)?.suggestions.map(s => s.id)).toEqual(['d1']);
        const fallback = finalResult({ suggestions: [] }, streamed, body);
        expect(fallback).toMatchObject({ sources: ['mail'], focus: 'invoices', mode: 'patterns' });
        expect(fallback?.suggestions.map(s => s.id)).toEqual(['p1']);
        expect(finalResult(null, [], body)).toBeNull();
    });
});

it('paints the last scan on mount without scanning again', async () => {
    const { view, stream } = setup({ last: lastScan() });
    await waitFor(() => expect(view.result.current.suggestions.map(s => s.title)).toEqual(['Invoice to sheet']));
    expect(stream).not.toHaveBeenCalled();
});

it('scans the connected sources and flags a changed selection as stale', async () => {
    const { view, stream } = setup();
    stream.mockImplementation(drive([['done', { suggestions: [{ id: 'p1', title: 'Weekly report', pattern: PATTERN }] }]]));
    await waitFor(() => expect(view.result.current.sourcesLoaded).toBe(true));
    await act(async () => { await view.result.current.scan(); });
    expect(stream).toHaveBeenCalledWith(
        { mode: 'patterns', sources: ['mail', 'files', 'beeflow'], focus: '', force: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        expect.any(Function), expect.anything(),
    );
    expect(view.result.current.suggestions.map(s => s.title)).toEqual(['Weekly report']);
    expect(view.result.current.stale).toBe(false);
    act(() => view.result.current.toggleSource('files'));
    expect([...view.result.current.selected]).toEqual(['mail', 'beeflow']);
    expect(view.result.current.stale).toBe(true);
});

it('sends the viewer\'s time zone only when the browser names one', async () => {
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Pacific/Honolulu' } as Intl.ResolvedDateTimeFormatOptions);
    expect(viewerTimeZone()).toBe('Pacific/Honolulu');
    zone.mockReturnValue({ timeZone: '' } as Intl.ResolvedDateTimeFormatOptions);
    expect(viewerTimeZone()).toBeNull();
    zone.mockImplementation(() => { throw new Error('no Intl'); });
    expect(viewerTimeZone()).toBeNull();
    zone.mockRestore();
});

it('keeps the previous result when a re-scan is rate-limited', async () => {
    const { view, stream } = setup({ last: lastScan() });
    stream.mockRejectedValue(Object.assign(new Error('Too many'), { status: 429, retryAfter: 20 }));
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));
    await act(async () => { await view.result.current.scan(true); });
    expect(view.result.current.cooldown).toBeGreaterThan(0);
    expect(view.result.current.cooldown).toBeLessThanOrEqual(20);
    expect(view.result.current.run.error).toBeNull();
    expect(view.result.current.suggestions).toHaveLength(1);
});

it('hides at once and sends "not repetitive" only when the undo window closes', async () => {
    const { view, postFeedback } = setup({ last: lastScan({ suggestions: [{ id: 's1', title: 'Invoice to sheet', pattern: { ...PATTERN } as never }] }) });
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));
    const s = view.result.current.suggestions[0];
    act(() => view.result.current.feedback.hide(s, 'dismissed', 'do_myself'));
    expect(view.result.current.suggestions).toHaveLength(0);
    expect(view.result.current.feedback.pending).toMatchObject({ action: 'dismissed', reasonCode: 'do_myself' });
    expect(postFeedback).not.toHaveBeenCalled();
    await waitFor(() => expect(postFeedback).toHaveBeenCalledWith({
        action: 'dismissed', signature: 'sig-1', reasonCode: 'do_myself',
        suggestion: { id: 's1', title: 'Invoice to sheet', requiredIntegrations: [], groundedIn: null, complexity: null },
    }));
    expect(view.result.current.feedback.pending).toBeNull();
});

it('Undo brings the pattern back and sends nothing', async () => {
    const { view, postFeedback } = setup({ last: lastScan(), undoMs: 80 });
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));
    act(() => view.result.current.feedback.hide(view.result.current.suggestions[0], 'snoozed'));
    act(() => view.result.current.feedback.undo());
    expect(view.result.current.suggestions).toHaveLength(1);
    await new Promise(r => setTimeout(r, 150));
    expect(postFeedback).not.toHaveBeenCalled();
});

it('brings the pattern back when the choice cannot be saved', async () => {
    const { view } = setup({ last: lastScan(), undoMs: 10, post: () => Promise.reject(new Error('down')) });
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));
    act(() => view.result.current.feedback.hide(view.result.current.suggestions[0], 'snoozed'));
    expect(view.result.current.suggestions).toHaveLength(0);
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));
});

it('Stop aborts the stream and remembers that it stopped', async () => {
    const { view, stream } = setup();
    let seen: AbortSignal | undefined;
    stream.mockImplementation((_b, onEvent, signal) => new Promise<void>((resolve) => {
        seen = signal;
        onEvent('suggestion', { suggestion: { id: 'p1', title: 'Half-named' } });
        signal?.addEventListener('abort', () => resolve());
    }));
    await waitFor(() => expect(view.result.current.sourcesLoaded).toBe(true));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = view.result.current.scan(); });
    expect(view.result.current.run.scanning).toBe(true);
    act(() => view.result.current.cancel());
    await act(async () => { await pending; });
    expect(seen?.aborted).toBe(true);
    expect(view.result.current.run).toMatchObject({ scanning: false, stopped: true });
    // What streamed before Stop is not kept as a result.
    expect(view.result.current.result).toBeNull();
    expect(view.result.current.suggestions).toEqual([]);
});

it('keeps ideas in their own list', async () => {
    const { view, stream } = setup({ last: lastScan() });
    stream.mockImplementation(drive([['done', { suggestions: [{ id: 'i1', title: 'An idea', groundedIn: 'idea' }] }]]));
    await waitFor(() => expect(view.result.current.sourcesLoaded).toBe(true));
    await act(async () => { await view.result.current.suggestIdeas(); });
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ideas' }), expect.any(Function), expect.anything());
    expect(view.result.current.ideas?.suggestions.map(s => s.title)).toEqual(['An idea']);
    expect(view.result.current.suggestions.map(s => s.title)).toEqual(['Invoice to sheet']);
});
