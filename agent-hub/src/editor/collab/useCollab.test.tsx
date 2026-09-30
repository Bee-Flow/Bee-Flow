/**
 * useCollab end to end against a scripted server: join, sync, the document
 * stream (joined with doc=/docSince=), presence named from the member list,
 * and teardown. The collab endpoints go through the injected HTTP seam; the
 * stream and the member list through the (mocked) authenticated fetch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { fromBase64, toBase64 } from 'lib0/buffer';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import useCollab from './useCollab';
import type { CollabHttp } from './provider';
import { authFetch } from '../../utils/helpers';

const fetchMock = authFetch as unknown as ReturnType<typeof vi.fn>;
const enc = new TextEncoder();

let streamCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
function openStream() {
    return {
        ok: true, status: 200,
        body: new ReadableStream<Uint8Array>({ start(c) { streamCtl = c; } }),
    };
}
const push = (event: string, data: unknown) => streamCtl!.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

function server({ canEdit = true } = {}) {
    const doc = new Y.Doc();
    const x = new Y.XmlText();
    const el = new Y.XmlElement('textblock');
    el.setAttribute('type', 'paragraph');
    el.insert(0, [x]);
    doc.getXmlFragment('content').insert(0, [el]);
    x.insert(0, 'from server');
    const calls: Array<{ path: string; body: any }> = [];
    const http: CollabHttp = {
        post: async (path: string, body: any) => {
            calls.push({ path, body });
            if (path.endsWith('/docs')) return { docId: 'd1', seq: 4, canEdit } as any;
            if (path.endsWith('/sync')) {
                return { update: toBase64(Y.encodeStateAsUpdate(doc, fromBase64(body.sv))), sv: toBase64(Y.encodeStateVector(doc)), seq: 4, canEdit } as any;
            }
            return { ok: true } as any;
        },
    };
    return { doc, calls, http };
}

function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
    fetchMock.mockReset();
    streamCtl = null;
    fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/stream')) return openStream();
        if (url.includes('/members')) {
            return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ownerId: 'u1', members: [], people: { u2: { name: 'Anna' } }, groups: {} }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    });
});
afterEach(() => { vi.useRealTimers(); });

describe('useCollab', () => {
    it('does nothing until it is enabled with a project, an item and a user', () => {
        const { http } = server();
        const { result } = renderHook(() => useCollab({ projectId: 'p1', kind: 'notebook', resourceId: 'n1', enabled: false, user: { id: 'u1' }, http }), { wrapper });
        expect(result.current).toBeNull();
        const noUser = renderHook(() => useCollab({ projectId: 'p1', kind: 'notebook', resourceId: 'n1', enabled: true, user: null, http }), { wrapper });
        expect(noUser.result.current).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('joins, syncs, follows the document stream and names who else is there', async () => {
        const { http, calls } = server();
        const { result, unmount } = renderHook(
            () => useCollab({ projectId: 'p1', kind: 'notebook', resourceId: 'n1', enabled: true, user: { id: 'u1' }, http }),
            { wrapper },
        );
        await waitFor(() => expect(result.current?.status).toBe('synced'));
        expect(result.current!.canEdit).toBe(true);
        expect(result.current!.fragment.toString()).toContain('from server');
        expect(calls[0]).toEqual({ path: '/api/projects/p1/docs', body: { kind: 'notebook', resourceId: 'n1' } });

        await waitFor(() => expect(streamCtl).not.toBeNull());
        const streamUrl = fetchMock.mock.calls.map((c) => c[0]).find((u: string) => u.includes('/stream'));
        expect(streamUrl).toBe('/api/projects/p1/stream?since=0&doc=d1&docSince=4');

        const peerDoc = new Y.Doc();
        const peer = new Awareness(peerDoc);
        peer.setLocalState({ user: { id: 'u2' }, cursor: null, editing: true });
        act(() => { push('doc.awareness', { docId: 'd1', u: toBase64(encodeAwarenessUpdate(peer, [peerDoc.clientID])) }); });
        await waitFor(() => expect(result.current!.peers).toHaveLength(1));
        await waitFor(() => expect(result.current!.peers[0]).toMatchObject({ userId: 'u2', name: 'Anna', editing: true }));

        unmount();
        expect(calls.some((c) => c.path.endsWith('/awareness') && typeof c.body.leave === 'number')).toBe(true);
        peer.destroy();
    });

    it('reports a viewer as read-only', async () => {
        const { http } = server({ canEdit: false });
        const { result } = renderHook(
            () => useCollab({ projectId: 'p1', kind: 'document', resourceId: 'x1', enabled: true, user: { id: 'u9' }, http }),
            { wrapper },
        );
        await waitFor(() => expect(result.current?.status).toBe('readonly'));
        expect(result.current!.canEdit).toBe(false);
    });

    it('reports a switched-off item as disabled and opens no stream', async () => {
        const http: CollabHttp = { post: async () => { throw Object.assign(new Error('off'), { status: 503, body: { code: 'COLLAB_DISABLED' } }); } };
        const { result } = renderHook(
            () => useCollab({ projectId: 'p1', kind: 'notebook', resourceId: 'n1', enabled: true, user: { id: 'u1' }, http }),
            { wrapper },
        );
        await waitFor(() => expect(result.current?.status).toBe('disabled'));
        expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/stream'))).toBe(false);
    });

});

describe('useCollab recovering and leaving', () => {
    it('starts a fresh session on retry(), so a page can rejoin after an ended one', async () => {
        const { http, calls } = server();
        const { result } = renderHook(
            () => useCollab({ projectId: 'p1', kind: 'notebook', resourceId: 'n1', enabled: true, user: { id: 'u1' }, http }),
            { wrapper },
        );
        await waitFor(() => expect(result.current?.status).toBe('synced'));
        const first = result.current!.ydoc;
        act(() => { result.current!.retry(); });
        await waitFor(() => expect(result.current?.ydoc).not.toBe(first));
        await waitFor(() => expect(result.current?.status).toBe('synced'));
        expect(calls.filter((c) => c.path.endsWith('/docs'))).toHaveLength(2);
    });

    it('opens the document stream again after the server let go of it for a passing reason', async () => {
        const { http } = server();
        const { result } = renderHook(
            () => useCollab({ projectId: 'p1', kind: 'notebook', resourceId: 'n1', enabled: true, user: { id: 'u1' }, http }),
            { wrapper },
        );
        await waitFor(() => expect(result.current?.status).toBe('synced'));
        await waitFor(() => expect(streamCtl).not.toBeNull());
        const streams = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/stream')).length;
        expect(streams()).toBe(1);
        act(() => { push('doc.closed', { docId: 'd1', reason: 'unavailable' }); });
        await waitFor(() => expect(result.current?.status).toBe('offline'));
        await waitFor(() => expect(streams()).toBe(2), { timeout: 3000 });
        act(() => { push('doc.joined', { docId: 'd1' }); });
        await waitFor(() => expect(result.current?.status).toBe('synced'));
    });

    it('sends unconfirmed edits when the page closes, and asks before leaving while any are left', async () => {
        const { http, calls, doc } = server();
        const { result } = renderHook(
            () => useCollab({ projectId: 'p1', kind: 'notebook', resourceId: 'n1', enabled: true, user: { id: 'u1' }, http }),
            { wrapper },
        );
        await waitFor(() => expect(result.current?.status).toBe('synced'));
        const quiet = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(quiet);
        expect(quiet.defaultPrevented).toBe(false);

        const text = (result.current!.fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
        act(() => { text.insert(0, 'unsent '); });
        const leaving = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(leaving);
        expect(leaving.defaultPrevented).toBe(true);

        act(() => { window.dispatchEvent(new Event('pagehide')); });
        const sent = calls.filter((c) => c.path.endsWith('/updates'));
        expect(sent).toHaveLength(1);
        const check = new Y.Doc();
        Y.applyUpdate(check, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(check, fromBase64(sent[0].body.updates[0]));
        expect(check.getXmlFragment('content').toString()).toContain('unsent');
    });
});
