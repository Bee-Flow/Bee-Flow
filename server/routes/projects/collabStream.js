// @typecheck
/**
 * GET /api/projects/:id/stream — the project's live feed, and optionally one
 * co-edited document on the same connection. The handler, as a factory so a
 * test can serve it with fakes; routes/projects.js mounts it behind
 * `requireProjectRole('viewer')` and the closed StreamQuery schema.
 *
 * Delivery is CURSOR-BASED, not push-only. Every durable frame carries
 * `id: <seq>`, so a client that drops reconnects with Last-Event-ID (or
 * ?since=) and replays exactly what it missed. Reconnect and live delivery are
 * the same code path, which is what makes "you never miss a message" true
 * rather than aspirational. The skeleton (ready frame, serialised drain with
 * backpressure, poll, access re-check, heartbeat) is core/http/cursorStream.js.
 *
 * The bus (core/projectEventBus.js) is only a doorbell: it says "project X
 * moved", and this handler reads forward from its cursor. Without Redis the
 * doorbell is in-process and the poll covers cross-replica delivery; with a
 * distributed bus the poll only backs up a dropped publish, so it stretches.
 *
 * `?doc=<docId>&docSince=<seq>` joins one co-edited document (core/collab):
 * its `doc.update`, `doc.awareness`, `doc.resync` and `doc.closed` frames carry
 * NO `id:` line, so they never move the project cursor; the client tracks the
 * document seq from the payload. Transient `doc.*` events on the bus are
 * routed by the document hub to the streams that joined that document, never
 * to every viewer of the project. A notebook is joined only by somebody the
 * notebooks gates let through (routes/projects/notebookGate.js), as on the
 * co-editing routes: its frames carry the notebook's body.
 */

'use strict';

const { closedPayload } = require('../../core/collab/docHub');

const STREAM_POLL_MS = 1500;
const STREAM_POLL_DISTRIBUTED_MS = 15_000;

/**
 * @param {{
 *   projectStore?: { getProjectEventSeq: (id: string) => Promise<number>, listProjectEvents: (id: string, since: number) => Promise<any> },
 *   bus?: { subscribeProject: (id: string, fn: (ev: any) => void) => () => void, isDistributed: () => boolean },
 *   getProjectRole?: (userId: string, projectId: string) => Promise<string|null>,
 *   collab?: { attachStream: (p: any) => Promise<any> },
 *   requireNotebooks?: (req: any, res: any, next: (err?: unknown) => void) => unknown,
 *   streamOptions?: object,
 *   log?: { warn: Function },
 * }} [deps]
 */
function makeProjectStreamHandler(deps = {}) {
    const projectStore = () => deps.projectStore || require('../../stores/projectStore');
    const bus = () => deps.bus || require('../../core/projectEventBus');
    const getProjectRole = (/** @type {string} */ u, /** @type {string} */ p) =>
        (deps.getProjectRole || require('../../auth/projectAccess').getProjectRole)(u, p);
    const collab = () => deps.collab || require('../../core/collab').instance();
    const log = deps.log || require('../../telemetry/log');
    const notebookGate = require('./notebookGate');
    const requireNotebooks = deps.requireNotebooks || notebookGate.makeNotebookGate();

    /**
     * May this request join a document of `kind`? A notebook needs the
     * notebooks gates; a refusal, or not being able to tell, is a no.
     * @param {any} req @param {string} kind
     */
    async function mayJoin(req, kind) {
        if (kind !== 'notebook') return true;
        try {
            await notebookGate.passNotebookGate(requireNotebooks, req);
            return true;
        } catch (_) {
            return false;
        }
    }

    /** @param {any} req @param {any} res */
    return async function projectStream(req, res) {
        const { openCursorStream } = require('../../core/http/cursorStream');
        const projectId = req.params.id;
        const userId = req.session?.user?.id;
        const docId = req.query.doc || null;

        const stream = await openCursorStream(req, res, {
            // Last-Event-ID is what EventSource sends on reconnect; ?since= is
            // for the fetch-based client.
            cursor: Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0,
            head: () => projectStore().getProjectEventSeq(projectId),
            readSince: (cursor) => projectStore().listProjectEvents(projectId, cursor),
            subscribe: (onEvent) => bus().subscribeProject(projectId, onEvent),
            // Groups are resolved fresh per call, so a removal takes effect
            // here within a minute rather than whenever the user next reloads.
            stillAllowed: async () => !!(await getProjectRole(userId, projectId)),
            readyPayload: () => ({ distributed: bus().isDistributed() }),
            onTransient: (ev, s) => {
                if (typeof ev.kind === 'string' && ev.kind.startsWith('doc.')) return;
                s.send(ev.kind || 'transient', ev);
            },
            onSlowConsumer: (s) => {
                if (docId) s.send('doc.resync', { docId, reason: 'slow_consumer' });
            },
            pollMs: () => (bus().isDistributed() ? STREAM_POLL_DISTRIBUTED_MS : STREAM_POLL_MS),
            log,
            ...(deps.streamOptions || {}),
        });

        if (docId && !stream.closed) {
            try {
                await collab().attachStream({
                    stream, projectId, userId, docId, docSince: req.query.docSince ?? null,
                    mayJoin: (/** @type {string} */ kind) => mayJoin(req, kind),
                });
            } catch (err) {
                // The project feed keeps working; the editor falls back to its
                // own sync when it sees the document closed.
                log.warn('[Projects] document stream attach failed:', /** @type {Error} */ (err).message);
                stream.send('doc.closed', closedPayload(docId, 'unavailable'));
            }
        }
    };
}

module.exports = { makeProjectStreamHandler, STREAM_POLL_MS, STREAM_POLL_DISTRIBUTED_MS };
