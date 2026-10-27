// @typecheck strict
/**
 * App Studio validator — a document picker (input_document) offers ONLY its own
 * documentIds and folder (appDocuments/pool.mts); with neither it can never offer
 * anything, so the builder hears about it.
 */

'use strict';

/**
 * @param {Record<string, unknown>} props
 * @param {string} path
 * @param {import('./shared').ValidationCtx} ctx
 */
function checkDocumentPicker(props, path, ctx) {
    const ids = Array.isArray(props.documentIds) ? props.documentIds.filter(Boolean) : [];
    if (ids.length || (typeof props.folderId === 'string' && props.folderId)) return;
    ctx.pushW({
        code: 'component.document_picker_empty', severity: 'warning', path: `${path}.props.documentIds`,
        message: 'This document picker names no documents and no folder, so it has nothing to offer.',
        hint: 'Set documentIds to the owner\'s documents it may offer, or folderId to one of the owner\'s document folders.',
    });
}

module.exports = { checkDocumentPicker };
