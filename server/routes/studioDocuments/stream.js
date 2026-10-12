// @typecheck
/**
 * GET /api/studio-documents/:id/stream — a live channel per Studio document.
 * Mounted by routes/studioDocuments.js.
 *
 * TRANSIENT ONLY: no ids, no replay (head 0, nothing to read). A frame is a
 * bus event published on `doc:<id>` (core/projectEventBus publishChannel), sent
 * under its `kind` as the SSE event name, e.g. `document.presence`. A client
 * that drops reconnects and simply carries on; whatever it must not miss is
 * loaded by the page itself. Anybody who can read the document may listen
 * (404 otherwise); the read right is asked again every minute and a stream
 * whose reader lost it gets `forbidden` and is closed.
 *
 * A FACTORY so a test serves it with fakes.
 */

'use strict';

const { notFound } = require('../../core/http/errors');

const CHANNEL_PREFIX = 'doc:';
/** The name of a document's channel on the bus. @param {string} id */
const documentChannel = (id) => `${CHANNEL_PREFIX}${id}`;

/**
 * @param {{
 *   documents?: { getDocument: (id: string, userId: string) => Promise<any> },
 *   bus?: { subscribeChannel: (channel: string, fn: (ev: any) => void) => () => void },
 *   requireAuth?: Function,
 *   streamOptions?: object,
 *   log?: { warn: Function },
 * }} [deps]
 */
function makeDocumentStreamRouter(deps = {}) {
    const router = require('express').Router({ mergeParams: true });
    const documents = () => deps.documents || require('../../stores/documentStore');
    const bus = () => deps.bus || require('../../core/projectEventBus');
    const requireAuth = deps.requireAuth || ((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => require('../../auth/permissions').requireAuth(req, res, next));

    router.get('/:id/stream', requireAuth, async (/** @type {any} */ req, /** @type {any} */ res) => {
        const { openCursorStream } = require('../../core/http/cursorStream');
        const userId = req.session.user.id;
        const id = req.params.id;
        if (!(await documents().getDocument(id, userId))) throw notFound('document_not_found', 'Document not found');
        await openCursorStream(req, res, {
            cursor: 0,
            head: async () => 0,
            readSince: async () => ({ events: [] }),
            subscribe: (onEvent) => bus().subscribeChannel(documentChannel(id), onEvent),
            stillAllowed: async () => !!(await documents().getDocument(id, userId)),
            // Every poll would find nothing; a long interval keeps it idle.
            pollMs: () => 3_600_000,
            log: deps.log || require('../../telemetry/log'),
            ...(deps.streamOptions || {}),
        });
    });

    return router;
}

module.exports = makeDocumentStreamRouter();
module.exports.makeDocumentStreamRouter = makeDocumentStreamRouter;
module.exports.documentChannel = documentChannel;
