/**
 * The provider when things go wrong in ways that may pass, and when the page
 * goes away: a sync that lands while a request is in flight, changes the
 * server finds too large, a document stream the server lets go of, a join
 * that fails for a moment, presence once the stream is attached, and edits
 * that are not confirmed yet when the editor or the page closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { fromBase64 } from 'lib0/buffer';
import type { CollabHttp, CollabProvider } from './provider';
import {
    HttpError, holdFirstUpdate, makeProvider, makeServer, queryCount, serverText, syncCount, typeText,
} from './providerTestkit';

let providers: CollabProvider[] = [];
beforeEach(() => { vi.useFakeTimers(); providers = []; });
afterEach(() => { providers.forEach((p) => p.destroy()); vi.useRealTimers(); });
const track = (p: CollabProvider) => { providers.push(p); return p; };

async function joined() {
    const server = makeServer();
    const p = track(makeProvider(server));
    await p.start();
    return { server, p };
}

describe('a sync while a request is in flight', () => {
    it('keeps the edits queued behind the request, sends them afterwards and stays honest about it', async () => {
        const server = makeServer();
        const held = holdFirstUpdate(server);
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'a'); typeText(p, 'b'); typeText(p, 'c');
        await vi.advanceTimersByTimeAsync(250);
        typeText(p, 'd');
        // The sync lands while the first request is still out (a resync frame, a reconnect, a poll).
        p.handleEvent('doc.resync', { docId: 'd1', reason: 'backlog' });
        await vi.advanceTimersByTimeAsync(20);
        typeText(p, 'e');
        held.release();
        await vi.advanceTimersByTimeAsync(500);
        expect(serverText(server)).toBe('abcde');
        typeText(p, 'f');
        await vi.advanceTimersByTimeAsync(500);
        expect(serverText(server)).toBe('abcdef');
        expect(p.status).toBe('synced');
        expect(p.hasPending()).toBe(false);
    });
});

describe('changes the server finds too large', () => {
    const LIMIT = 3000;
    function capped() {
        const server = makeServer();
        const accepted: number[] = [];
        server.overrides.set('/updates', async (body) => {
            const u = fromBase64(body.updates[0]);
            if (u.length > LIMIT) throw new HttpError(413, 'UPDATE_TOO_LARGE');
            accepted.push(u.length);
            Y.applyUpdate(server.doc, u);
            return { seq: 9 };
        });
        return { server, accepted };
    }

    it('splits a batch that is too large together and sends every part', async () => {
        const { server, accepted } = capped();
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'x'.repeat(1200)); typeText(p, 'y'.repeat(1200)); typeText(p, 'z'.repeat(1200));
        await vi.advanceTimersByTimeAsync(3000);
        expect(serverText(server)).toBe('x'.repeat(1200) + 'y'.repeat(1200) + 'z'.repeat(1200));
        expect(accepted.length).toBeGreaterThanOrEqual(2);
        expect(p.status).toBe('synced');
    });

    it('sends everything queued before a change that is too large on its own, then ends the session', async () => {
        const { server } = capped();
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'kept');
        typeText(p, 'x'.repeat(LIMIT + 500));
        await vi.advanceTimersByTimeAsync(3000);
        expect(serverText(server)).toBe('kept');
        expect(p.status).toBe('error');
        expect(p.lastError).toBe('UPDATE_TOO_LARGE');
    });
});

describe('a document stream the server let go of', () => {
    it('checks with a sync, keeps and sends queued edits, polls, and reopens the stream', async () => {
        const { server, p } = await joined();
        typeText(p, 'kept');
        const syncsBefore = syncCount(server);
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'unavailable' });
        expect(p.status).toBe('offline');
        await vi.advanceTimersByTimeAsync(300);
        expect(syncCount(server)).toBe(syncsBefore + 1);
        expect(serverText(server)).toBe('kept');
        const epoch = p.streamEpoch;
        await vi.advanceTimersByTimeAsync(1000);
        expect(p.streamEpoch).toBe(epoch + 1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(syncCount(server)).toBeGreaterThan(syncsBefore + 1);
        // The reopened stream is attached: back to live, polling stops.
        p.handleEvent('doc.joined', { docId: 'd1' });
        expect(p.status).toBe('synced');
        const syncsNow = syncCount(server);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(syncCount(server)).toBe(syncsNow);
    });

    it('ends the session only when the sync confirms the document is gone', async () => {
        const { server, p } = await joined();
        server.overrides.set('/sync', async () => { throw new HttpError(404, 'NOT_FOUND'); });
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'not_found' });
        await vi.advanceTimersByTimeAsync(20);
        expect(p.status).toBe('error');
        expect(p.lastError).toBe('NOT_FOUND');
        const epoch = p.streamEpoch;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(p.streamEpoch).toBe(epoch);
    });

    it('reads an organisation that switched co-editing off as disabled, not as lost access', async () => {
        const { p } = await joined();
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'detached', cause: 'disabled' });
        expect(p.status).toBe('disabled');
        expect(p.lastError).toBe('COLLAB_DISABLED');
    });
});

describe('a session that ends while edits are not confirmed', () => {
    it('a fold-back that closes the document before a queued edit left: the edit is marked unsent, not silently gone', async () => {
        const { server, p } = await joined();
        typeText(p, 'typed during the fence');
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'detached' });
        expect(p.status).toBe('disabled');
        expect(p.unsent).toBe(true);
        expect(serverText(server)).toBe('');
        expect(p.fragment.toString()).toContain('typed during the fence');
    });

    it('a batch the detach fence refused (503 COLLAB_CLOSING) and doc.closed before its retry: marked unsent, never dropped', async () => {
        const { server, p } = await joined();
        server.overrides.set('/updates', async () => { throw new HttpError(503, 'COLLAB_CLOSING'); });
        typeText(p, 'typed while it folded back');
        await vi.advanceTimersByTimeAsync(300);
        expect(server.calls.filter((c) => c.path.endsWith('/updates'))).toHaveLength(1);
        // The same fold-back closes the document before the retry (at least 1 s later) goes out.
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'detached' });
        expect(p.status).toBe('disabled');
        expect(p.unsent).toBe(true);
        expect(p.fragment.toString()).toContain('typed while it folded back');
        await vi.advanceTimersByTimeAsync(5000);
        expect(server.calls.filter((c) => c.path.endsWith('/updates'))).toHaveLength(1);
    });

    it('an offline backlog the server answers with 404 (the item moved meanwhile): marked unsent', async () => {
        const { server, p } = await joined();
        server.overrides.set('/updates', async () => { throw new HttpError(503, 'COLLAB_CLOSING'); });
        typeText(p, 'half an hour of typing');
        await vi.advanceTimersByTimeAsync(300);
        server.overrides.set('/updates', async () => { throw new HttpError(404, 'NOT_FOUND'); });
        await vi.advanceTimersByTimeAsync(2000);
        expect(p.status).toBe('error');
        expect(p.unsent).toBe(true);
    });

    it('a change too large to share ends the session with it unsent', async () => {
        const { server, p } = await joined();
        server.overrides.set('/updates', async () => { throw new HttpError(413, 'UPDATE_TOO_LARGE'); });
        typeText(p, 'a huge paste');
        await vi.advanceTimersByTimeAsync(300);
        expect(p.status).toBe('error');
        expect(p.unsent).toBe(true);
    });

    it('everything confirmed: a session that ends has nothing unsent', async () => {
        const { p } = await joined();
        typeText(p, 'sent');
        await vi.advanceTimersByTimeAsync(300);
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'detached' });
        expect(p.status).toBe('disabled');
        expect(p.unsent).toBe(false);
    });
});

describe('joining when the server cannot answer yet', () => {
    it('keeps connecting and retries a join that may pass, with backoff', async () => {
        const server = makeServer();
        let failures = 2;
        server.overrides.set('/docs', async () => {
            if (failures > 0) { failures -= 1; throw new HttpError(0); }
            return { docId: 'd1', seq: 3, canEdit: true };
        });
        const p = track(makeProvider(server));
        await p.start();
        expect(p.status).toBe('connecting');
        await vi.advanceTimersByTimeAsync(1000);
        expect(p.status).toBe('connecting');
        await vi.advanceTimersByTimeAsync(2000);
        expect(p.status).toBe('synced');
        expect(p.ready).toBe(true);
    });

    it('retries a first sync refused by the rate limit, and a busy document', async () => {
        const server = makeServer();
        server.overrides.set('/sync', async () => { server.overrides.delete('/sync'); throw new HttpError(429); });
        const p = track(makeProvider(server));
        await p.start();
        expect(p.status).toBe('connecting');
        await vi.advanceTimersByTimeAsync(1000);
        expect(p.status).toBe('synced');

        const busy = makeServer();
        busy.overrides.set('/docs', async () => { busy.overrides.delete('/docs'); throw new HttpError(503, 'COLLAB_BUSY'); });
        const q = track(makeProvider(busy));
        await q.start();
        expect(q.status).toBe('connecting');
        await vi.advanceTimersByTimeAsync(1000);
        expect(q.status).toBe('synced');
    });

    it('still ends at once on a definite refusal, without retrying', async () => {
        const server = makeServer();
        server.overrides.set('/docs', async () => { throw new HttpError(403, 'FORBIDDEN'); });
        const p = track(makeProvider(server));
        await p.start();
        expect(p.status).toBe('error');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(server.calls.filter((c) => c.path.endsWith('/docs'))).toHaveLength(1);
    });
});

describe('presence once the stream is attached', () => {
    it('shows itself at once but asks who is here only when its document stream is attached', async () => {
        const server = makeServer();
        const p = track(makeProvider(server));
        await p.start();
        expect(server.calls.some((c) => c.path.endsWith('/awareness') && c.body.update)).toBe(true);
        expect(queryCount(server)).toBe(0);
        p.handleEvent('doc.joined', { docId: 'd1' });
        expect(queryCount(server)).toBe(1);
        p.handleReady({ reconnect: true });
        p.handleEvent('doc.joined', { docId: 'd1' });
        expect(queryCount(server)).toBe(2);
    });
});

describe('leaving with edits not confirmed yet', () => {
    it('sends the edits queued behind a request still in flight when the editor is torn down', async () => {
        const server = makeServer();
        const held = holdFirstUpdate(server);
        const p = makeProvider(server);
        await p.start();
        typeText(p, 'a');
        await vi.advanceTimersByTimeAsync(250);
        typeText(p, 'b');
        expect(p.hasPending()).toBe(true);
        p.destroy();
        await vi.advanceTimersByTimeAsync(20);
        expect(serverText(server)).toBe('ab');
        held.release();
        await vi.advanceTimersByTimeAsync(20);
        expect(serverText(server)).toBe('ab');
    });

    it('sends them with a request that outlives the page when it closes', async () => {
        const server = makeServer();
        const beacons: Array<{ path: string; body: any }> = [];
        const http: CollabHttp = { post: server.http.post, beacon: (path, body) => { beacons.push({ path, body }); } };
        const p = track(makeProvider(server, { http }));
        await p.start();
        typeText(p, 'bye');
        p.flushOnExit();
        expect(beacons).toHaveLength(1);
        expect(beacons[0].path).toBe('/api/projects/p1/docs/d1/updates');
        const doc = new Y.Doc();
        Y.applyUpdate(doc, fromBase64(beacons[0].body.updates[0]));
        expect((doc.getXmlFragment('content').get(0) as Y.XmlText).toString()).toBe('bye');
        expect(server.calls.some((c) => c.path.endsWith('/awareness') && c.body.leave === p.ydoc.clientID)).toBe(true);
        await vi.advanceTimersByTimeAsync(300);
        expect(p.hasPending()).toBe(false);
    });
});
