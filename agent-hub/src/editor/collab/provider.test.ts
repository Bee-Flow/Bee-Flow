import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { CollabProvider, REMOTE_ORIGIN } from './provider';
import { HttpError, makeProvider, makeServer, typeText, updateCalls } from './providerTestkit';

/**
 * The HTTP provider against a scripted server: a real Y.Doc on the "server"
 * answers /sync, and every request is recorded so the tests can pin the
 * transport rules (batching, one request in flight, retry, read-only, resync).
 */

let providers: CollabProvider[] = [];
beforeEach(() => { vi.useFakeTimers(); providers = []; });
afterEach(() => { providers.forEach((p) => p.destroy()); vi.useRealTimers(); });
const track = (p: CollabProvider) => { providers.push(p); return p; };

describe('joining', () => {
    it('joins, syncs the server state in and reports synced for an editor', async () => {
        const server = makeServer();
        const x = new Y.XmlText(); server.doc.getXmlFragment('content').insert(0, [x]); x.insert(0, 'hello');
        const p = track(makeProvider(server));
        await p.start();
        expect(server.calls[0]).toEqual({ path: '/api/projects/p1/docs', body: { kind: 'notebook', resourceId: 'n1' } });
        expect(server.calls[1].path).toBe('/api/projects/p1/docs/d1/sync');
        expect(p.status).toBe('synced');
        expect(p.ready).toBe(true);
        expect(p.seq).toBe(3);
        expect((p.fragment.get(0) as Y.XmlText).toString()).toBe('hello');
    });

    it('is read-only for a viewer and never sends document updates', async () => {
        const server = makeServer({ canEdit: false });
        const p = track(makeProvider(server));
        await p.start();
        expect(p.status).toBe('readonly');
        typeText(p, 'x');
        await vi.advanceTimersByTimeAsync(2000);
        expect(updateCalls(server)).toHaveLength(0);
    });

    it('reports a switched-off or unsupported item as disabled, so the caller falls back', async () => {
        const server = makeServer();
        server.overrides.set('/docs', async () => { throw new HttpError(409, 'COLLAB_UNSUPPORTED'); });
        const p = track(makeProvider(server));
        await p.start();
        expect(p.status).toBe('disabled');
        expect(p.lastError).toBe('COLLAB_UNSUPPORTED');

        const off = makeServer();
        off.overrides.set('/docs', async () => { throw new HttpError(503, 'COLLAB_DISABLED'); });
        const q = track(makeProvider(off));
        await q.start();
        expect(q.status).toBe('disabled');
    });

    it('reports an item that is not in the project as an error', async () => {
        const server = makeServer();
        server.overrides.set('/docs', async () => { throw new HttpError(404, 'NOT_FOUND'); });
        const p = track(makeProvider(server));
        await p.start();
        expect(p.status).toBe('error');
        expect(p.ready).toBe(false);
    });
});

describe('sending', () => {
    it('batches a burst of local edits into one request carrying ONE merged update', async () => {
        const server = makeServer();
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'a'); typeText(p, 'b'); typeText(p, 'c');
        await vi.advanceTimersByTimeAsync(150);
        expect(updateCalls(server)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(100);
        const calls = updateCalls(server);
        expect(calls).toHaveLength(1);
        expect(calls[0].body.clientId).toBe(p.ydoc.clientID);
        // The server's rate limit counts updates, not requests: fast typing must cost one per request.
        expect(calls[0].body.updates).toHaveLength(1);
        expect((server.doc.getXmlFragment('content').get(0) as Y.XmlText).toString()).toBe('abc');
    });

    it('keeps one request in flight and sends what queued up meanwhile afterwards', async () => {
        const server = makeServer();
        let release: (v: unknown) => void = () => {};
        let first = true;
        server.overrides.set('/updates', (body) => {
            if (first) { first = false; return new Promise((r) => { release = () => { for (const u of body.updates) Y.applyUpdate(server.doc, fromBase64(u)); r({ seq: 4 }); }; }); }
            for (const u of body.updates) Y.applyUpdate(server.doc, fromBase64(u));
            return Promise.resolve({ seq: 5 });
        });
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'a');
        await vi.advanceTimersByTimeAsync(250);
        typeText(p, 'b');
        await vi.advanceTimersByTimeAsync(1000);
        expect(updateCalls(server)).toHaveLength(1);
        release(null);
        await vi.advanceTimersByTimeAsync(300);
        expect(updateCalls(server)).toHaveLength(2);
        expect((server.doc.getXmlFragment('content').get(0) as Y.XmlText).toString()).toBe('ab');
    });

    it('keeps a failed batch, goes offline, retries with backoff and recovers', async () => {
        const server = makeServer();
        let failures = 2;
        server.overrides.set('/updates', async (body) => {
            if (failures > 0) { failures -= 1; throw new HttpError(503); }
            for (const u of body.updates) Y.applyUpdate(server.doc, fromBase64(u));
            return { seq: 9 };
        });
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'kept');
        await vi.advanceTimersByTimeAsync(250);
        expect(p.status).toBe('offline');
        await vi.advanceTimersByTimeAsync(1000);
        expect(updateCalls(server)).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2000);
        expect(updateCalls(server)).toHaveLength(3);
        expect(p.status).toBe('synced');
        expect(updateCalls(server)[2].body.updates).toEqual(updateCalls(server)[0].body.updates);
        expect((server.doc.getXmlFragment('content').get(0) as Y.XmlText).toString()).toBe('kept');
    });

});

describe('sending refused', () => {
    it('turns read-only when the server refuses an update for the role', async () => {
        const server = makeServer();
        server.overrides.set('/updates', async () => { throw new HttpError(403, 'FORBIDDEN'); });
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'x');
        await vi.advanceTimersByTimeAsync(250);
        expect(p.status).toBe('readonly');
        expect(p.canEdit).toBe(false);
        typeText(p, 'y');
        await vi.advanceTimersByTimeAsync(5000);
        expect(updateCalls(server)).toHaveLength(1);
    });

    it('stops with the server\'s code when a change is too large', async () => {
        const server = makeServer();
        server.overrides.set('/updates', async () => { throw new HttpError(413, 'DOC_TOO_LARGE'); });
        const p = track(makeProvider(server));
        await p.start();
        typeText(p, 'x');
        await vi.advanceTimersByTimeAsync(250);
        expect(p.status).toBe('error');
        expect(p.lastError).toBe('DOC_TOO_LARGE');
    });
});

async function joined() {
    const server = makeServer();
    const p = track(makeProvider(server));
    await p.start();
    return { server, p };
}

function remoteUpdate(text: string) {
    const other = new Y.Doc();
    const x = new Y.XmlText();
    other.getXmlFragment('content').insert(0, [x]);
    x.insert(0, text);
    return toBase64(Y.encodeStateAsUpdate(other));
}

describe('receiving', () => {
    it('applies a burst of stream frames once per frame, in one transaction', async () => {
        const { p } = await joined();
        const onTx = vi.fn();
        p.ydoc.on('afterTransaction', (tr: Y.Transaction) => { if (tr.origin === REMOTE_ORIGIN) onTx(); });
        p.handleEvent('doc.update', { docId: 'd1', from: 4, seq: 4, u: remoteUpdate('one') });
        p.handleEvent('doc.update', { docId: 'd1', from: 5, seq: 5, u: remoteUpdate('two') });
        expect(p.fragment.length).toBe(0);
        await vi.advanceTimersByTimeAsync(20);
        expect(p.fragment.length).toBe(2);
        expect(onTx).toHaveBeenCalledTimes(1);
        expect(p.seq).toBe(5);
    });

    it('ignores frames of another document', async () => {
        const { p } = await joined();
        p.handleEvent('doc.update', { docId: 'other', from: 4, seq: 4, u: remoteUpdate('x') });
        await vi.advanceTimersByTimeAsync(20);
        expect(p.fragment.length).toBe(0);
        expect(p.seq).toBe(3);
    });

    it('resyncs when frames were missed, when asked to, and after a reconnect', async () => {
        const { server, p } = await joined();
        const syncs = () => server.calls.filter((c) => c.path.endsWith('/sync')).length;
        expect(syncs()).toBe(1);
        p.handleEvent('doc.update', { docId: 'd1', from: 9, seq: 9, u: remoteUpdate('x') });
        await vi.advanceTimersByTimeAsync(20);
        expect(syncs()).toBe(2);
        p.handleEvent('doc.resync', { docId: 'd1', reason: 'backlog' });
        await vi.advanceTimersByTimeAsync(20);
        expect(syncs()).toBe(3);
        p.handleReady({ reconnect: false });
        await vi.advanceTimersByTimeAsync(20);
        expect(syncs()).toBe(3);
        p.handleReady({ reconnect: true });
        await vi.advanceTimersByTimeAsync(20);
        expect(syncs()).toBe(4);
    });

});

describe('reconnecting and closing', () => {
    it('sends edits made while disconnected with the next sync', async () => {
        const { server, p } = await joined();
        server.overrides.set('/updates', async () => { throw new HttpError(0); });
        typeText(p, 'offline words');
        await vi.advanceTimersByTimeAsync(250);
        server.overrides.delete('/updates');
        p.handleReady({ reconnect: true });
        await vi.advanceTimersByTimeAsync(2000);
        expect((server.doc.getXmlFragment('content').get(0) as Y.XmlText).toString()).toBe('offline words');
    });

    it('ends the session on a closed document, but only re-reads on a role change', async () => {
        const { server, p } = await joined();
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'role_changed' });
        await vi.advanceTimersByTimeAsync(20);
        expect(p.status).toBe('synced');
        expect(server.calls.filter((c) => c.path.endsWith('/sync'))).toHaveLength(2);
        p.handleEvent('doc.closed', { docId: 'd1', reason: 'deleted' });
        expect(p.status).toBe('error');
        expect(p.lastError).toBe('DELETED');

        const again = await joined();
        again.p.handleEvent('doc.closed', { docId: 'd1', reason: 'detached' });
        expect(again.p.status).toBe('disabled');
    });

    it('goes offline only after the stream stayed down a moment, and syncs on a timer while polling', async () => {
        const { server, p } = await joined();
        p.handleStreamStatus('connecting');
        await vi.advanceTimersByTimeAsync(1000);
        expect(p.status).toBe('synced');
        p.handleStreamStatus('polling');
        await vi.advanceTimersByTimeAsync(2500);
        expect(p.status).toBe('offline');
        const before = server.calls.filter((c) => c.path.endsWith('/sync')).length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(server.calls.filter((c) => c.path.endsWith('/sync')).length).toBeGreaterThan(before);
        p.handleStreamStatus('live');
        expect(p.status).toBe('synced');
    });
});

describe('presence', () => {
    it('sends its own presence throttled, applies others\' and answers a query', async () => {
        const server = makeServer();
        const p = track(makeProvider(server));
        await p.start();
        const awarenessPosts = () => server.calls.filter((c) => c.path.endsWith('/awareness') && c.body.update);
        const initial = awarenessPosts().length;
        p.awareness.setLocalStateField('cursor', { anchor: 'a', head: 'a' });
        p.awareness.setLocalStateField('cursor', { anchor: 'b', head: 'b' });
        await vi.advanceTimersByTimeAsync(300);
        expect(awarenessPosts().length).toBe(initial + 1);

        const peerDoc = new Y.Doc();
        const peer = new Awareness(peerDoc);
        peer.setLocalState({ user: { id: 'u2' }, cursor: null, editing: true });
        p.handleEvent('doc.awareness', { docId: 'd1', u: toBase64(encodeAwarenessUpdate(peer, [peerDoc.clientID])) });
        expect(p.awareness.getStates().get(peerDoc.clientID)).toMatchObject({ user: { id: 'u2' } });

        p.handleEvent('doc.awareness.query', { docId: 'd1' });
        expect(awarenessPosts().length).toBe(initial + 2);
        peer.destroy();
    });

    it('says goodbye when it is torn down', async () => {
        const server = makeServer();
        const p = makeProvider(server);
        await p.start();
        p.destroy();
        expect(server.calls.some((c) => c.path.endsWith('/awareness') && c.body.leave === p.ydoc.clientID)).toBe(true);
    });
});
