import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * The `metadata` SSE event and the `seedMetadata` request field.
 *
 * The server sends `metadata` after every accepted builder_set_metadata and
 * after it names an untitled draft itself (finalize, auto-finalize, turn
 * end). The header reads its title off the server row, so what the shell
 * needs from the hook is a counter that moves on each — `metadataSeq` — plus
 * the title for anyone who wants it without a refetch. A host's seed title
 * travels in the request body only when one was given.
 */

const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const flush = () => new Promise((r) => setTimeout(r, 0));

function openBody() {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    return { stream, push: (c) => controller.enqueue(c), close: () => controller.close() };
}

describe('useAutomationBuilderStream — metadata', () => {
    let lastBody;
    beforeEach(() => {
        lastBody = null;
        authFetch.mockReset();
    });

    async function start(sendArgs) {
        const body = openBody();
        authFetch.mockImplementation(async (url, opts) => {
            lastBody = JSON.parse(opts.body);
            return { ok: true, status: 200, body: body.stream };
        });
        const { result } = renderHook(() => useAutomationBuilderStream({}));
        await act(async () => { result.current.send({ message: 'build it', modelTier: 'fast', ...sendArgs }); await flush(); });
        return { result, body };
    }

    it('starts unnamed with metadataSeq 0', () => {
        const { result } = renderHook(() => useAutomationBuilderStream({}));
        expect(result.current.state.title).toBeNull();
        expect(result.current.state.metadataSeq).toBe(0);
    });

    it('a metadata event sets the title, adopts the id and bumps metadataSeq once per event', async () => {
        const { result, body } = await start({});
        await act(async () => { body.push(sse('metadata', { automationId: 'auto_1', title: 'Facturen inlezen', description: '' })); await flush(); });
        expect(result.current.state.title).toBe('Facturen inlezen');
        expect(result.current.state.automationId).toBe('auto_1');
        expect(result.current.state.metadataSeq).toBe(1);
        await act(async () => { body.push(sse('metadata', { automationId: 'auto_1', title: 'Facturen inlezen (dagelijks)', description: 'x' })); await flush(); });
        expect(result.current.state.title).toBe('Facturen inlezen (dagelijks)');
        expect(result.current.state.metadataSeq).toBe(2);
        // A malformed event moves the counter (the shell refetches) but never
        // blanks the title.
        await act(async () => { body.push(sse('metadata', { automationId: 'auto_1' })); await flush(); });
        expect(result.current.state.title).toBe('Facturen inlezen (dagelijks)');
        expect(result.current.state.metadataSeq).toBe(3);
    });

    it('sends seedMetadata in the body only when the caller gave one', async () => {
        await start({ seedMetadata: { title: 'Facturen inlezen' } });
        expect(lastBody.seedMetadata).toEqual({ title: 'Facturen inlezen' });
        await start({});
        expect(lastBody.seedMetadata).toBeUndefined();
        await start({ seedMetadata: null });
        expect(lastBody.seedMetadata).toBeUndefined();
    });
});
