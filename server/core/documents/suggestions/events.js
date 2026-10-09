'use strict';

/**
 * "The suggestions of this document changed": ids and counts only, never text.
 * On the document's own channel (`doc:<id>`, read by GET /:id/stream) and, for
 * a document filed in a project, the project's bus too.
 */

const log = require('../../../telemetry/log');

/**
 * @param {{ documentId: string, projectId?: string|null, batchId?: string|null, open: number }} change
 * @param {{ bus?: { publishChannel: Function, publishTransient: Function } }} [deps]
 */
async function announceSuggestions({ documentId, projectId = null, batchId = null, open }, deps = {}) {
    const bus = deps.bus || require('../../projectEventBus');
    const event = {
        kind: 'doc.suggestions', transient: true, targetType: 'document', targetId: documentId,
        payload: { documentId, batchId, open },
    };
    try {
        await bus.publishChannel(`doc:${documentId}`, event);
        if (projectId) await bus.publishTransient(projectId, event);
    } catch (err) {
        log.warn('[Suggestions] event not published:', err && err.message);
    }
}

module.exports = { announceSuggestions };
