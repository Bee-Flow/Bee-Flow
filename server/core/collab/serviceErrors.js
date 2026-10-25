// @typecheck strict
/**
 * How the co-editing service (./service.js) answers the routes when it
 * refuses: the client-facing texts and the mapping of the lower layers'
 * errors onto HttpErrors with a code the client falls back on.
 */

'use strict';

const { HttpError, notFound } = require('../http/errors');
const { CollabStoreError } = require('../../stores/collabDocStore');
const { CollabWireError } = require('./wire');
const { CollabConvertError } = require('./convert');

const DISABLED_TEXT = 'Co-editing is switched off for this organisation. The document opens for one editor at a time.';
const UNAVAILABLE_TEXT = 'Co-editing is not available for this item right now. It opens for one editor at a time.';
const UNSUPPORTED_TEXT = 'This item is not co-edited. It opens in its own editor.';

/** Turn the lower layers' refusals into HttpErrors with a client-facing code. @param {unknown} err */
function toHttp(err) {
    if (err instanceof HttpError) return err;
    if (err instanceof CollabWireError) return new HttpError(err.status, err.code, err.message);
    if (err instanceof CollabStoreError) {
        if (err.code === 'NOT_FOUND') return notFound('not_found', 'Not found');
        if (err.code === 'DOC_TOO_LARGE') return new HttpError(413, 'DOC_TOO_LARGE', 'This document has reached its size limit. Remove some content (large images, pasted data) and try again.');
        if (err.code === 'CLIENT_ID_CONFLICT') return new HttpError(409, 'CLIENT_ID_CONFLICT', 'This editing session clashes with another one. Reconnect to continue.');
        if (err.code === 'STATE_MOVING') return new HttpError(503, 'COLLAB_BUSY', 'The document is busy. Try again in a moment.');
        // Being folded back into its item: a retry lands after the fold-back
        // (on the item itself), or goes through if it did not happen.
        if (err.code === 'DOC_CLOSING') return new HttpError(503, 'COLLAB_CLOSING', 'Live editing of this item is closing. Try again in a moment.');
    }
    if (err instanceof CollabConvertError) return new HttpError(503, 'COLLAB_UNAVAILABLE', UNAVAILABLE_TEXT);
    return /** @type {Error} */ (err);
}

module.exports = { toHttp, DISABLED_TEXT, UNAVAILABLE_TEXT, UNSUPPORTED_TEXT };
