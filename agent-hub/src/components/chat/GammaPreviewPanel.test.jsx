import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GammaPreviewPanel from './GammaPreviewPanel';

/**
 * The status poller ran a closure captured on the first render, so a preview
 * that changed while the generation was still pending was merged from the
 * stale copy: the update handed back fields the caller had already replaced.
 */

vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => authFetch(...args),
}));

function pendingResponse() {
    return { ok: true, status: 200, json: async () => ({ status: 'pending' }) };
}

describe('GammaPreviewPanel polling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        authFetch.mockReset();
        authFetch.mockImplementation(async () => pendingResponse());
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('merges the LATEST preview on every poll, not the one from first render', async () => {
        const onUpdate = vi.fn();
        const first = { generationId: 'g1', status: 'pending', title: 'first' };
        const { rerender } = render(<GammaPreviewPanel preview={first} onUpdate={onUpdate} onClose={() => {}} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(onUpdate).toHaveBeenLastCalledWith({ generationId: 'g1', status: 'pending', title: 'first' });

        rerender(<GammaPreviewPanel preview={{ ...first, title: 'second' }} onUpdate={onUpdate} onClose={() => {}} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(7000); });

        expect(onUpdate).toHaveBeenLastCalledWith({ generationId: 'g1', status: 'pending', title: 'second' });
    });

    it('polls the generation endpoint every seven seconds while pending', async () => {
        render(<GammaPreviewPanel preview={{ generationId: 'g1', status: 'pending' }} onUpdate={() => {}} onClose={() => {}} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(authFetch.mock.calls[0][0]).toBe('/integrations/gamma/generations/g1');

        await act(async () => { await vi.advanceTimersByTimeAsync(14000); });
        expect(authFetch).toHaveBeenCalledTimes(3);
    });

    it('stops polling once the generation is no longer pending', async () => {
        const { rerender } = render(<GammaPreviewPanel preview={{ generationId: 'g1', status: 'pending' }} onUpdate={() => {}} onClose={() => {}} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        rerender(<GammaPreviewPanel preview={{ generationId: 'g1', status: 'failed' }} onUpdate={() => {}} onClose={() => {}} />);
        const calls = authFetch.mock.calls.length;

        await act(async () => { await vi.advanceTimersByTimeAsync(21000); });
        expect(authFetch).toHaveBeenCalledTimes(calls);
    });
});
