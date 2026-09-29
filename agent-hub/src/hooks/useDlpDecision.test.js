import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useDlpDecision from './useDlpDecision';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
});

function dispatch(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
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

        expect(authFetch).toHaveBeenCalledTimes(1);
        const [, opts] = authFetch.mock.calls[0];
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

        const [, opts] = authFetch.mock.calls[0];
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
