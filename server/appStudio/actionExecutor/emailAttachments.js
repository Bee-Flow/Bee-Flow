/**
 * App Studio action executor — the attachments of a send_email step (moved out
 * of emailStep.js unchanged): ledger-verified files only, never a URL.
 */
// @typecheck strict
'use strict';

const studioAppDataStore = require('../../stores/studioAppDataStore');
const { resolveBinding } = require('./shared');

/**
 * The attachments of a reply: ledger-verified files only, never a URL; at most
 * ten descriptors are read, and undefined when none passes.
 * @param {AppRef} app
 * @param {EmailStepDef} step
 * @param {import('./shared').ExecCtx} ctx
 * @param {import('./shared').ServerScope} scope
 */
async function collectMailAttachments(app, step, ctx, scope) {
    if (step.attachments === undefined || step.attachments === null) return undefined;
    const raw = resolveBinding(step.attachments, ctx, scope);
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const attachments = [];
    for (const desc of list.slice(0, 10)) {
        const entry = await mailAttachmentFor(app, desc);
        if (entry) attachments.push(entry);
    }
    return attachments.length ? attachments : undefined;
}

/**
 * One attachment descriptor (a file id, or an object with fileId and name) as
 * a mail attachment, or null when the file is not in this app's ledger or not
 * past the malware scan.
 * @param {AppRef} app
 * @param {string | { fileId?: string, name?: unknown } | null | undefined} desc
 */
async function mailAttachmentFor(app, desc) {
    const fileId = typeof desc === 'string' ? desc : desc?.fileId;
    if (!fileId) return null;
    const att = await studioAppDataStore.getAttachment(fileId, app.id, app.userId);
    // Same bar as an automation file input: in this app's ledger, and
    // past the malware scan.
    if (!att || !att.scanned || att.quarantined) return null;
    const storageStore = require('../../stores/storageStore');
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, att.sha256);
    // The display name lives on the DESCRIPTOR — the ledger has no
    // name column, so a name read off the ledger alone went out as "bijlage".
    // The ledger stays as a fallback for the day it grows one.
    const ledgerName = /** @type {{ name?: unknown }} */ (att).name;
    const rawName = (desc && typeof desc === 'object' && typeof desc.name === 'string' && desc.name)
        ? desc.name : (typeof ledgerName === 'string' ? ledgerName : '');
    const filename = rawName.replace(/[/\\\r\n\0"]/g, '').trim().slice(0, 200) || 'bijlage';
    // The BYTES, not the key: MailComposer reads `path` as a local file path,
    // so handing it the storage key failed every send with an attachment, and
    // the Graph path needs the bytes for contentBytes anyway.
    const { stream } = await storageStore.streamFile(key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { filename, content: Buffer.concat(chunks), contentType: att.mimeType };
}

/**
 * @typedef {{ id: string, userId: string }} AppRef
 * @typedef {{ attachments?: import('./shared').Binding }} EmailStepDef  the send_email fields the attachment helper reads
 */

module.exports = { collectMailAttachments };
