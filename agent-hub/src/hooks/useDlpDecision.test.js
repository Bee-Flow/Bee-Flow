import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useDlpDecision, { DLP_TOUCH_INTERVAL_MS } from './useDlpDecision';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
});

afterEach(() => {
    vi.useRealTimers();
});

function dispatch(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** authFetch calls to the decision endpoint itself (not the touch heartbeat). */
function decisionCalls() {
    return authFetch.mock.calls.filter(([url]) => url.endsWith('/api/chat/dlp-decision'));
}

function touchCalls() {
    return authFetch.mock.calls.filter(([url]) => url.endsWith('/api/chat/dlp-decision/touch'));
}

describe('useDlpDecision — pending shape', () => {
    it('a dlp_preview event tags pending as kind:"chat_text"', () => {
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_preview', { decisionId: 'd1', reviewText: 'hello Alice', findings: [] }));
        expect(result.current.pending.kind).toBe('chat_text');
        expect(result.current.pending.decisionId).toBe('d1');
    });

    it('a dlp_attachment_preview event tags pending as kind:"attachment" and carries the filename', () => {
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_attachment_preview', { decisionId: 'd2', filename: 'report.pdf', reviewText: 'contents', findings: [] }));
        expect(result.current.pending.kind).toBe('attachment');
        expect(result.current.pending.filename).toBe('report.pdf');
    });

    it('dlp_resolved / dlp_blocked clear pending regardless of which kind was showing', () => {
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_attachment_preview', { decisionId: 'd3', filename: 'x.pdf' }));
        expect(result.current.pending).not.toBeNull();
        act(() => dispatch('beeflow:dlp_blocked', {}));
        expect(result.current.pending).toBeNull();
    });
});

describe('useDlpDecision — submit', () => {
    it('posts choice + rememberForConversation, omits manualAdditions when none given', async () => {
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_preview', { decisionId: 'd4', reviewText: 'x', findings: [] }));

        await act(async () => { await result.current.submit('allow', { rememberForConversation: true }); });

        expect(decisionCalls().length).toBe(1);
        const [, opts] = decisionCalls()[0];
        const body = JSON.parse(opts.body);
        expect(body).toEqual({ decisionId: 'd4', choice: 'allow', rememberForConversation: true });
        expect(result.current.pending).toBeNull();
    });

    it('includes manualAdditions in the POST body when the user marked extra spans', async () => {
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_attachment_preview', { decisionId: 'd5', filename: 'y.pdf', reviewText: 'x', findings: [] }));

        await act(async () => {
            await result.current.submit('redact', { manualAdditions: [{ offset: 0, length: 5 }] });
        });

        const [, opts] = decisionCalls()[0];
        const body = JSON.parse(opts.body);
        expect(body.manualAdditions).toEqual([{ offset: 0, length: 5 }]);
        expect(body.decisionId).toBe('d5');
    });

    it('a failed POST surfaces an error and keeps pending open (no silent send)', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'Decision not found' }) });
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_preview', { decisionId: 'd6', reviewText: 'x', findings: [] }));

        await act(async () => { await result.current.submit('redact'); });

        expect(result.current.error).toBe('Decision not found');
        expect(result.current.pending).not.toBeNull();
    });
});

describe('useDlpDecision — keep-alive heartbeat', () => {
    it('heartbeats the decision immediately and on the interval while the review is open', () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_preview', { decisionId: 'd7', reviewText: 'x', findings: [] }));

        expect(touchCalls().length).toBe(1);
        expect(JSON.parse(touchCalls()[0][1].body)).toEqual({ decisionId: 'd7' });

        act(() => { vi.advanceTimersByTime(DLP_TOUCH_INTERVAL_MS * 3); });
        expect(touchCalls().length).toBe(4);
        expect(result.current.pending).not.toBeNull();
    });

    it('a heartbeat failure leaves the review alone — submit still reports its own error', async () => {
        authFetch.mockImplementation((url) => (
            url.endsWith('/touch')
                ? Promise.reject(new Error('offline'))
                : Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
        ));
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_preview', { decisionId: 'd8', reviewText: 'x', findings: [] }));

        await act(async () => { await result.current.submit('redact'); });

        expect(result.current.error).toBeNull();
        expect(result.current.pending).toBeNull();
    });

    it('stops heartbeating once the decision is submitted', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useDlpDecision());
        act(() => dispatch('beeflow:dlp_preview', { decisionId: 'd9', reviewText: 'x', findings: [] }));
        expect(touchCalls().length).toBe(1);

        await act(async () => { await result.current.submit('allow'); });
        act(() => { vi.advanceTimersByTime(DLP_TOUCH_INTERVAL_MS * 5); });
        expect(touchCalls().length).toBe(1);
    });
});
