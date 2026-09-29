import React, { createRef } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DocumentCanvas from './DocumentCanvas';

const api = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../utils/helpers', () => api);
vi.mock('./documentsApi', () => ({ previewUrl: id => `/preview/${id}` }));
beforeEach(() => api.authFetch.mockResolvedValue({ ok: true, text: async () => '<p>Document</p>' }));
afterEach(cleanup);
const message = (frame, data) => act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data })));

it('queues an insertion while the preview reloads and applies it after readiness', async () => {
    const ref = createRef();
    render(<DocumentCanvas ref={ref} documentId="d" editing reloadKey={0}/>);
    const frame = screen.getByTitle('Document');
    await waitFor(() => expect(frame.srcdoc).toContain('Document'));
    const post = vi.spyOn(frame.contentWindow, 'postMessage');
    ref.current.insert('customer.name');
    expect(post).not.toHaveBeenCalled();
    message(frame, { __beeflowDocReady: true });
    expect(post).toHaveBeenCalledWith({ __beeflowDocInsert: true, key: 'customer.name' }, '*');
});

it('waits for the iframe acknowledgement and reports its final text before resolving flush', async () => {
    const ref = createRef(), onDirty = vi.fn(), finished = vi.fn();
    render(<DocumentCanvas ref={ref} documentId="d" editing onDirty={onDirty}/>);
    const frame = screen.getByTitle('Document');
    await waitFor(() => expect(frame.srcdoc).toContain('Document'));
    const post = vi.spyOn(frame.contentWindow, 'postMessage');
    const pending = ref.current.flush().then(finished);
    expect(finished).not.toHaveBeenCalled();
    message(frame, { __beeflowDocReady: true });
    const command = post.mock.calls.find(([m]) => m.__beeflowDocFlush)[0];
    message(frame, { __beeflowDocDirty: true, html: '<p>Newest</p>', requestId: command.requestId });
    await pending;
    expect(onDirty).toHaveBeenCalledWith('<p>Newest</p>');
    expect(onDirty.mock.invocationCallOrder[0]).toBeLessThan(finished.mock.invocationCallOrder[0]);
});
