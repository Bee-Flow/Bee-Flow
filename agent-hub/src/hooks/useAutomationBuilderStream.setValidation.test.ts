import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * BFSF-58 — the validation chip and the node badges read `state.validation`,
 * and the AI builder's `validation_errors` event was its only writer. A manual
 * save gets the server's verdict back but had no way to put it there, so the
 * chip kept showing the builder's last pass. `setValidation` is that way in;
 * a builder pass that arrives afterwards still wins, because it describes the
 * newer draft.
 */

const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const flush = () => new Promise((r) => setTimeout(r, 0));
const mockedFetch = vi.mocked(authFetch);

describe('useAutomationBuilderStream.setValidation', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('replaces the validation state, and clears it with empty lists', () => {
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        const warning = { code: 'condition.dead_branch', message: 'Step c1: no else edge.', path: 'steps[c1]' };
        act(() => { result.current.setValidation({ errors: [], warnings: [warning] }); });
        expect(result.current.state.validation).toEqual({ errors: [], warnings: [warning] });

        act(() => { result.current.setValidation({ errors: [], warnings: [] }); });
        expect(result.current.state.validation).toEqual({ errors: [], warnings: [] });
    });

    it('is overwritten by a later builder pass', async () => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
        mockedFetch.mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response);
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));

        act(() => { result.current.setValidation({ errors: [], warnings: [{ message: 'from the save' }] }); });
        await act(async () => { result.current.send({ message: 'build it', modelTier: 'fast' }); await flush(); });
        await act(async () => {
            controller!.enqueue(sse('validation_errors', { errors: [{ message: 'from the builder' }], warnings: [] }));
            await flush();
        });
        expect(result.current.state.validation).toEqual({ errors: [{ message: 'from the builder' }], warnings: [] });
    });
});
