/**
 * provider.ts — keeps a Y.Doc in step with the server over plain HTTP + SSE.
 *
 * The server's collab endpoints (all under /api/projects/:id):
 *   POST /docs {kind, resourceId}           → {docId, seq, canEdit}   join
 *   POST /docs/:docId/sync {sv}              → {update, sv, seq, canEdit}
 *   POST /docs/:docId/updates {clientId, updates}  → {seq}   (editors only)
 *   POST /docs/:docId/awareness {update}|{query}|{leave}
 * and the project stream, joined with `doc=<docId>&docSince=<seq>`, which
 * carries doc.update / doc.awareness / doc.awareness.query / doc.resync /
 * doc.joined / doc.closed frames (useCollab owns that subscription and feeds
 * handleEvent; a bumped `streamEpoch` asks it to open the stream again).
 *
 * Rules this file keeps:
 *   - Outgoing updates are batched (BATCH_MS) with ONE request in flight and
 *     one merged update per request (sender.ts, outbox.ts). A failed request
 *     keeps its batch and retries with backoff; a batch the server finds too
 *     large is split. Re-sending is safe: applying a Yjs update twice is a no-op.
 *   - Incoming updates are applied once per animation frame in a single
 *     transaction, so a burst of remote typing costs one editor refresh.
 *   - Any doubt (a gap in the sequence, a reconnect, a resync frame, a stream
 *     the server let go of, the tab coming back) is answered with a
 *     state-vector sync, which is idempotent.
 *   - Only a definite answer ends the session (403/404, deleted, switched
 *     off, a change the server can never take). Anything that may pass is
 *     retried, joining included, and never drops an unsent edit. When the
 *     session does end with edits the server never confirmed (typed during
 *     a fold-back, a backlog from offline, a paste too large to share), they
 *     are still in `ydoc` and the editor: `unsent` says so, and the page keeps
 *     them (a version) before anything replaces the editor.
 *   - A viewer never sends document updates (the server refuses them anyway), and
 *     nothing here logs or reports document content: errors carry codes only.
 */
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { setLocalUser } from './awareness';
import { InboundQueue } from './inbound';
import { PresenceChannel } from './presence';
import { Sender } from './sender';
import { StreamState } from './streamState';
import {
    MAX_RETRY_MS, REMOTE_ORIGIN, codeOf, errorOf, hasContent, joinFailure,
    type CollabProviderOptions, type CollabStatus, type SyncResponse,
} from './providerSupport';
import { FRAGMENT_NAME } from './ySchema';

export { REMOTE_ORIGIN, type CollabHttp, type CollabKind, type CollabProviderOptions, type CollabStatus } from './providerSupport';

type Timer = ReturnType<typeof setTimeout>;

export class CollabProvider {
    readonly ydoc: Y.Doc;
    readonly fragment: Y.XmlFragment;
    readonly awareness: Awareness;
    status: CollabStatus = 'connecting';
    canEdit = false;
    docId: string | null = null;
    /** Highest document sequence seen; the stream resumes after it. */
    seq = 0;
    /** True once the first sync landed; stays true (the editor stays bound). */
    ready = false;
    /** The session ended while edits made here were not confirmed: they exist only in this document now. */
    unsent = false;
    lastError?: string;
    /** Bumped on every observable change (useSyncExternalStore snapshot). */
    version = 0;
    /** Bumped when the document stream has to be opened again (the server let go of it). */
    streamEpoch = 0;

    private readonly opts: CollabProviderOptions;
    private readonly base: string;
    private readonly presence: PresenceChannel;
    private readonly sender: Sender;
    private readonly stream: StreamState;
    private readonly inbound: InboundQueue;
    private listeners = new Set<() => void>();
    private sendFailing = false;
    private joinTimer: Timer | null = null;
    private joinDelay = 1000;
    private syncing: Promise<void> | null = null;
    private syncAgain = false;
    private destroyed = false;

    constructor(opts: CollabProviderOptions) {
        this.opts = opts;
        this.base = `/api/projects/${encodeURIComponent(opts.projectId)}/docs`;
        this.ydoc = new Y.Doc();
        this.fragment = this.ydoc.getXmlFragment(FRAGMENT_NAME);
        this.awareness = new Awareness(this.ydoc);
        setLocalUser(this.awareness, opts.userId);
        this.presence = new PresenceChannel(this.awareness, {
            post: (body) => this.postAwareness(body),
            live: () => !!this.docId && !this.destroyed && !this.isFinal(),
            changed: () => this.emit(),
        });
        this.stream = new StreamState({
            sync: () => { this.sync(); },
            changed: () => this.settle(),
            reopen: () => { this.streamEpoch += 1; this.emit(); },
            ended: () => this.isFinal(),
        });
        this.inbound = new InboundQueue(this.ydoc, () => {
            this.warn('[collab] a remote update could not be applied; resyncing');
            this.sync();
        }, opts.scheduleFrame);
        this.sender = new Sender({
            http: opts.http,
            batchMs: opts.batchMs,
            target: () => (this.docId && this.canEdit && !this.isFinal()
                ? { path: `${this.base}/${encodeURIComponent(this.docId)}/updates`, clientId: this.ydoc.clientID } : null),
            failing: () => { this.sendFailing = true; this.settle(); },
            sent: () => { if (this.sendFailing) { this.sendFailing = false; this.settle(); } },
            refused: (code) => { this.canEdit = false; this.lastError = code; this.settle(); this.emit(); },
            fatal: (code) => this.fatal('error', code),
        });
        this.ydoc.on('update', this.onLocalUpdate);
    }

    /* ── observers (useSyncExternalStore) ─────────────────── */
    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    private emit() {
        this.version += 1;
        for (const fn of this.listeners) { try { fn(); } catch { /* one listener must not stop the rest */ } }
    }
    private warn(message: string) { try { this.opts.onWarn?.(message); } catch { /* noop */ } }

    private setStatus(next: CollabStatus, error?: string) {
        if (error !== undefined) this.lastError = error;
        if (this.status === next && error === undefined) return;
        this.status = next;
        this.emit();
    }

    /** End the session. Only for definite answers: nothing queued is sent afterwards. */
    private fatal(status: 'error' | 'disabled', code: string) {
        if (this.canEdit && this.sender.pending) this.unsent = true;
        this.clearTimers();
        this.sender.stop();
        this.setStatus(status, code || 'UNKNOWN');
    }

    private isFinal() { return this.status === 'error' || this.status === 'disabled' || this.destroyed; }

    /** Recompute the steady-state status from the flags. */
    private settle() {
        if (this.isFinal() || !this.ready) return;
        if (this.sendFailing || this.stream.offline) this.setStatus('offline');
        else this.setStatus(this.canEdit ? 'synced' : 'readonly');
    }

    /* ── join + sync ──────────────────────────────────────── */

    /**
     * Join and run the first sync. A failure that may pass (network, rate
     * limit, a busy server) is tried again with backoff while the status stays
     * 'connecting'; only a definite answer ends the session.
     */
    async start(): Promise<void> {
        if (this.destroyed || this.isFinal() || this.ready) return;
        try {
            if (!this.docId) {
                const res = await this.opts.http.post<{ docId: string; seq: number; canEdit: boolean }>(
                    this.base, { kind: this.opts.kind, resourceId: this.opts.resourceId },
                );
                if (this.destroyed) return;
                if (!res || typeof res.docId !== 'string') { this.fatal('error', 'BAD_RESPONSE'); return; }
                this.docId = res.docId;
                this.canEdit = res.canEdit === true;
                this.emit();
            }
            await this.sync();
        } catch (e) {
            if (this.destroyed) return;
            const { status, code } = errorOf(e);
            const failure = joinFailure(status, code);
            if (failure.retry) this.retryJoin(); else this.fatal(failure.final, failure.code);
            return;
        }
        if (this.destroyed || this.isFinal()) return;
        if (!this.ready) { this.retryJoin(); return; }
        this.joinDelay = 1000;
        // Others see us now; who is already here is asked once our stream is attached (doc.joined).
        this.presence.send();
    }

    private retryJoin() {
        if (this.joinTimer || this.destroyed || this.isFinal()) return;
        const delay = this.joinDelay;
        this.joinDelay = Math.min(delay * 2, MAX_RETRY_MS);
        this.joinTimer = setTimeout(() => { this.joinTimer = null; this.start(); }, delay);
    }

    /** State-vector sync. Concurrent calls collapse into one follow-up run. */
    sync(): Promise<void> {
        if (this.syncing) { this.syncAgain = true; return this.syncing; }
        this.syncing = (async () => {
            do {
                this.syncAgain = false;
                await this.syncOnce();
            } while (this.syncAgain && !this.destroyed && !this.isFinal());
        })().finally(() => { this.syncing = null; });
        return this.syncing;
    }

    private async syncOnce(): Promise<void> {
        if (!this.docId || this.destroyed) return;
        const sv = toBase64(Y.encodeStateVector(this.ydoc));
        let res: SyncResponse | null;
        try {
            res = await this.opts.http.post<SyncResponse>(`${this.base}/${encodeURIComponent(this.docId)}/sync`, { sv });
        } catch (e) {
            if (!this.destroyed) this.onSyncFailed(e);
            return;
        }
        if (this.destroyed || this.isFinal() || !res) return;
        try {
            if (res.update) Y.applyUpdate(this.ydoc, fromBase64(res.update), REMOTE_ORIGIN);
        } catch {
            this.fatal('error', 'BAD_UPDATE');
            return;
        }
        if (typeof res.seq === 'number' && res.seq > this.seq) this.seq = res.seq;
        if (typeof res.canEdit === 'boolean') this.canEdit = res.canEdit;
        this.queueMissing(res.sv);
        this.sendFailing = false;
        this.ready = true;
        this.settle();
        this.emit();
    }

    private onSyncFailed(e: unknown) {
        const { status, code } = errorOf(e);
        if (!this.ready) {
            // Before the first sync start() decides; it retries what may pass.
            const failure = joinFailure(status, code);
            if (!failure.retry) this.fatal(failure.final, failure.code);
            return;
        }
        if (status === 404) { this.fatal('error', codeOf(status, code, 'NOT_FOUND')); return; }
        if (status === 403) { this.fatal('error', codeOf(status, code, 'FORBIDDEN')); return; }
        this.warn(`[collab] sync failed (${status || 'network'})`);
        this.sendFailing = true;
        this.settle();
    }

    /** Whatever this client has that the server lacks (edits made while a request failed or the connection was down). */
    private queueMissing(serverSv: string | undefined) {
        if (!this.canEdit) { this.sender.clear(); return; }
        if (!serverSv) return;
        try {
            const missing = Y.encodeStateAsUpdate(this.ydoc, fromBase64(serverSv));
            if (hasContent(missing)) this.sender.catchUp(missing, Y.encodeStateVector(this.ydoc));
        } catch { /* a bad state vector only costs the catch-up */ }
    }

    /* ── outgoing (sender.ts) ─────────────────────────────── */
    private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE_ORIGIN || this.destroyed || !this.canEdit || this.isFinal()) return;
        this.sender.push(update);
    };

    /** Send the queued updates now (one request in flight at a time). */
    flush(): Promise<void> { return this.sender.flush(); }

    /** Edits this client made that the server has not confirmed yet. */
    hasPending(): boolean {
        return !this.destroyed && this.canEdit && !this.isFinal() && this.sender.pending;
    }

    /* ── incoming ─────────────────────────────────────────── */
    /** One frame off the project stream (only doc.* frames matter here). */
    handleEvent(kind: string, raw: unknown) {
        if (this.destroyed) return;
        if (kind === 'forbidden') { this.fatal('error', 'FORBIDDEN'); return; }
        const handler = this.frameHandlers[kind];
        if (!handler) return;
        const ev = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        if (!this.docId || ev.docId !== this.docId) return;
        handler(ev);
    }

    private readonly frameHandlers: Record<string, (ev: Record<string, unknown>) => void> = {
        'doc.update': (ev) => this.onUpdateFrame(ev),
        'doc.awareness': (ev) => this.presence.apply(ev.u),
        'doc.awareness.query': () => this.presence.send(),
        'doc.resync': () => { this.sync(); },
        // Our document stream is attached: answers reach us from now on, so ask who is here.
        'doc.joined': () => { this.stream.joined(); this.presence.announce(); },
        'doc.closed': (ev) => this.onClosedFrame(String(ev.reason ?? ''), String(ev.cause ?? '')),
    };

    private onUpdateFrame(ev: Record<string, unknown>) {
        if (typeof ev.u !== 'string') return;
        const from = Number(ev.from);
        const seq = Number(ev.seq);
        // A hole in the sequence means frames were lost: the sync fills it.
        if (this.ready && Number.isFinite(from) && from > this.seq + 1) this.sync();
        if (Number.isFinite(seq) && seq > this.seq) this.seq = seq;
        try { this.inbound.push(fromBase64(ev.u)); } catch { this.sync(); }
    }

    private onClosedFrame(reason: string, cause: string) {
        switch (reason) {
            case 'role_changed': this.sync(); return;
            // Live editing ended, the item is still there (moved out, switched off).
            case 'detached': case 'disabled':
                this.fatal('disabled', reason === 'disabled' || cause === 'disabled' ? 'COLLAB_DISABLED' : 'DETACHED');
                return;
            case 'deleted': this.fatal('error', 'DELETED'); return;
            // 'not_found', 'unavailable' or a reason this client does not know:
            // the attach may have hit a passing fault. The sync this starts
            // decides (403/404 end the session); the stream is reopened.
            default: this.stream.detach();
        }
    }

    /** The stream (re)connected: anything missed is fetched by a sync (presence follows doc.joined). */
    handleReady({ reconnect }: { reconnect: boolean }) {
        if (!reconnect || this.destroyed || !this.ready) return;
        this.sync();
    }

    /** Transport state of the stream: down for a while = offline; polling = sync on a timer. */
    handleStreamStatus(status: 'connecting' | 'live' | 'polling' | 'stopped') {
        if (this.destroyed) return;
        if (status === 'stopped') this.fatal('error', 'FORBIDDEN');
        else this.stream.transport(status);
    }

    private postAwareness(body: Record<string, unknown>) {
        if (!this.docId) return;
        this.opts.http.post(`${this.base}/${encodeURIComponent(this.docId)}/awareness`, body)
            .catch(() => { /* presence is best-effort; the next heartbeat repairs it */ });
    }

    /* ── teardown ─────────────────────────────────────────── */
    private clearTimers() {
        this.sender.cancel();
        if (this.joinTimer) { clearTimeout(this.joinTimer); this.joinTimer = null; }
        this.stream.cancel();
        this.inbound.cancel();
        this.presence.cancel();
    }

    /** Best-effort goodbye (page hidden for good); the 30 s timeout covers a lost one. */
    leave() {
        if (this.docId && !this.destroyed) this.presence.leave();
    }

    /** The page is going away: send what is not confirmed with requests that outlive it, then say goodbye. */
    flushOnExit() {
        if (this.destroyed) return;
        this.sender.sendRest(true);
        this.leave();
    }

    destroy() {
        if (this.destroyed) return;
        // Last chance for unconfirmed edits (the batch in flight too); the requests outlive the component.
        this.sender.sendRest(false);
        this.leave();
        this.destroyed = true;
        this.clearTimers();
        this.sender.stop();
        this.ydoc.off('update', this.onLocalUpdate);
        this.presence.destroy();
        this.listeners.clear();
        this.ydoc.destroy();
    }
}
