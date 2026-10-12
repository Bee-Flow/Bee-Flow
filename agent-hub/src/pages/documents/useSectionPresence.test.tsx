import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '../../utils/helpers';
import useSectionPresence, { foldAnswer, type PeerMap } from './useSectionPresence';

/**
 * Who else is in a designed document, and in which section
 * (useSectionPresence). With more than one server, a beat's answer lists only
 * the peers of the server that took it; a colleague on another server reaches
 * this editor through the document's live stream alone. The answer must never
 * wipe what the stream said, or "Bob is editing Pricing" flickers on and off
 * and disappears exactly when this editor moves into Bob's section.
 *
 * The network is the app's own request seam (setDemoTransport): the live
 * stream is a response body the test writes frames into, and each presence
 * beat is answered with what "this server" knows.
 */

const peer = (clientId: string, userId: string, sectionId: string | null, state: 'viewing' | 'editing' = 'editing') => ({ clientId, userId, sectionId, state });

describe('foldAnswer', () => {
    const bobFromStream: PeerMap = { 'bob-c': { ...peer('bob-c', 'bob', 'pricing'), at: 1, viaStream: true } };

    it('keeps a peer the stream told us about when the answer leaves it out', () => {
        const next = foldAnswer(bobFromStream, [peer('cas-c', 'cas', 'intro')], 2);
        expect(Object.keys(next).sort()).toEqual(['bob-c', 'cas-c']);
        expect(next['bob-c'].sectionId).toBe('pricing');
    });

    it("the stream's word on a peer stands over one server's memory of it", () => {
        const next = foldAnswer(bobFromStream, [peer('bob-c', 'bob', 'intro')], 2);
        expect(next['bob-c']).toEqual(bobFromStream['bob-c']);
    });

    it('a peer only an answer ever listed goes when the next answer leaves it out', () => {
        const once = foldAnswer({}, [peer('cas-c', 'cas', 'intro')], 1);
        expect(Object.keys(foldAnswer(once, [], 2))).toEqual([]);
    });

    it('ignores rows without a client or a user', () => {
        expect(foldAnswer({}, [{ clientId: 'x' }, { userId: 'y' }, null], 1)).toEqual({});
        expect(foldAnswer({}, 'nonsense', 1)).toEqual({});
    });
});

describe('useSectionPresence across servers', () => {
    const enc = new TextEncoder();
    let push: (frame: string) => void = () => undefined;
    let serverView: unknown[] = [];

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        serverView = [];
        setDemoTransport(async (url: string, init: RequestInit = {}) => {
            if (url.includes('/api/studio-documents/d1/stream')) {
                const body = new ReadableStream({ start(controller) { push = (frame) => controller.enqueue(enc.encode(frame)); } });
                return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
            }
            if (url.includes('/api/studio-documents/d1/presence') && init.method === 'POST') {
                return Response.json({ peers: serverView, ttlMs: 45_000, people: {} });
            }
            return Response.json({}, { status: 200 });
        });
    });
    afterEach(() => { setDemoTransport(null); vi.useRealTimers(); });

    const streamBeat = (clientId: string, userId: string, sectionId: string | null, state: string) => push(
        `event: document.presence\ndata: ${JSON.stringify({ kind: 'document.presence', actorId: userId, targetType: 'document', targetId: 'd1', payload: { documentId: 'd1', clientId, sectionId, state } })}\n\n`,
    );

    function mount() {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <QueryClientProvider client={qc}>
                {children}
            </QueryClientProvider>
        );
        return renderHook((props: { caretSection: string | null }) => useSectionPresence({
            documentId: 'd1', enabled: true, editing: true, caretSection: props.caretSection, currentUserId: 'anna',
        }), { wrapper, initialProps: { caretSection: 'intro' } });
    }

    const sections = (peers: Array<{ userId: string; sectionId: string | null }>) => peers.map((p) => `${p.userId}:${p.sectionId}`).sort();

    it("a colleague on another server stays visible through this editor's own beats", async () => {
        const hook = mount();
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        // Bob's beats land on the other server: this one learns of him from the stream.
        await act(async () => { streamBeat('bob-c', 'bob', 'pricing', 'editing'); await vi.advanceTimersByTimeAsync(50); });
        await waitFor(() => expect(sections(hook.result.current.peers)).toEqual(['bob:pricing']));

        // Anna moves into Pricing; her beat's answer knows only Cas.
        serverView = [peer('cas-c', 'cas', 'intro')];
        hook.rerender({ caretSection: 'pricing' });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        await waitFor(() => expect(sections(hook.result.current.peers)).toEqual(['bob:pricing', 'cas:intro']));

        // Cas leaves this server; Bob is still there, until he leaves.
        serverView = [];
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        expect(sections(hook.result.current.peers)).toEqual(['bob:pricing']);
        await act(async () => { streamBeat('bob-c', 'bob', null, 'left'); await vi.advanceTimersByTimeAsync(50); });
        await waitFor(() => expect(hook.result.current.peers).toEqual([]));
        hook.unmount();
    });
});
