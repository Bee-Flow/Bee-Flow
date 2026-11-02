// @typecheck
/**
 * file_intake phase 1 — which conversation, which attachments table, and
 * the attachment rows the VIEWER may read. Never client-supplied fileIds,
 * never owner scope. The connectors and stepDataSource modules are lent by
 * the orchestrator, so this module stays out of the import cycle they sit in.
 */

'use strict';
const { DEFAULT_PO_PATTERN } = require('./naming');
const { attachmentsTableFor, fileFieldOf, hasField } = require('./attachmentRows');
const { MAX_FILES_PER_INTAKE } = require('./limits');

/**
 * The conversation and the attachments table the step points at, or the
 * `{ ok: false, error }` that says why there is none.
 */
function resolveIntakeSource(model, step, ctx, { resolveBinding, scope, connectors }) {
    const threadKeyRaw = resolveBinding(step.threadKey, ctx, scope);
    const threadKey = typeof threadKeyRaw === 'string' ? threadKeyRaw.trim() : (threadKeyRaw == null ? '' : String(threadKeyRaw));
    if (!threadKey) return { ok: false, error: 'No conversation was selected' };

    const connector = connectors.findConnector(model, step.connectorId);
    if (!connector || connector.kind !== 'mailbox') {
        return { ok: false, error: 'This action is not connected to a mailbox' };
    }
    const attTable = attachmentsTableFor(model, connector);
    if (!attTable) return { ok: false, error: 'This mailbox does not record attachments' };
    if (!hasField(attTable, 'thread_key')) {
        return { ok: false, error: 'The attachments table has no thread_key column' };
    }
    const fileField = fileFieldOf(attTable);
    if (!fileField) return { ok: false, error: 'The attachments table has no file column' };
    return { threadKey, attTable, fileField };
}

/**
 * The purchase-order filename pattern, compiled through core/text/userPattern
 * (RE2, or the native engine off the event loop with a time budget). A
 * pattern that does not compile, nests quantifiers, or was saved before the
 * save-time check falls back to the default. classify() calls `.test(name)`;
 * an undecidable answer counts as "not a purchase order".
 * @param {{ poPattern?: unknown }} step
 * @returns {{ test(name: string): boolean }}
 */
function compilePoPattern(step) {
    const { compileUserPattern, testUserPattern } = require('../../core/text/userPattern');
    const src = step.poPattern && typeof step.poPattern === 'string' ? step.poPattern : DEFAULT_PO_PATTERN;
    let compiled = compileUserPattern(src, { caseInsensitive: true });
    if (!compiled.ok) compiled = compileUserPattern(DEFAULT_PO_PATTERN, { caseInsensitive: true });
    const pattern = compiled;
    return { test: (name) => testUserPattern(pattern, String(name)) === true };
}

/** The attachment rows of the conversation, read as the viewer; null when unreadable. */
async function locateAttachments(app, model, { attTable, threadKey, viewer, ctx, scope, resolveBinding, stepDataSource }) {
    // A synthetic records binding through the same reader promptContext uses:
    // the real query compiler, under the viewer's row-level access. Inline
    // images (signature logos) are excluded when the column exists.
    /** @type {Array<{field: string, op: string, value: any, required?: boolean}>} */
    const filter = [{ field: 'thread_key', op: 'eq', value: threadKey, required: true }];
    if (hasField(attTable, 'is_inline')) filter.push({ field: 'is_inline', op: 'eq', value: false });
    return stepDataSource.resolveDataBinding(app, model, {
        kind: 'records',
        tableId: attTable.id,
        filter,
        sort: hasField(attTable, 'filename') ? [{ field: 'filename', dir: 'asc' }] : undefined,
    }, {
        viewer,
        role: ctx.role ?? null,
        resolveValue: (b) => resolveBinding(b, ctx, scope),
        maxRows: MAX_FILES_PER_INTAKE + 1,
    });
}

module.exports = { resolveIntakeSource, compilePoPattern, locateAttachments };
