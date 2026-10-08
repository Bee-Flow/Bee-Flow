'use strict';

const crypto = require('node:crypto');
const content = require('./documentCrypto');

const storage = () => require('../storageStore');

async function openBuffer(key, buffer) {
    const text = buffer.toString('utf8');
    if (!content.envelopeOf(text)) return buffer;
    return Buffer.from(await content.open(text, 'notebook-file', key, 'bytes'), 'base64');
}

async function sealBuffer(resource, key, buffer, context) {
    const value = await content.seal(buffer.toString('base64'), { ...resource, type: 'notebook-file', id: key }, 'bytes', { context });
    return content.envelopeOf(value) ? Buffer.from(value, 'utf8') : buffer;
}

async function readBuffer(key) {
    const { stream } = await storage().streamFile(key);
    const parts = [];
    for await (const chunk of stream) parts.push(Buffer.from(chunk));
    return openBuffer(key, Buffer.concat(parts));
}

// The DB pointer is changed in the sharing transaction; old bytes are removed
// only after commit, and newly uploaded bytes are removed on rollback.
async function transition(client, row, resource, context, files) {
    if (!row.storage_key || row.storage_key.startsWith('local:')) return;
    const buffer = await readBuffer(row.storage_key);
    const key = `${row.storage_key}.encrypted-${crypto.randomUUID()}`;
    files.created.push(key);
    await storage().uploadFile(key, await sealBuffer(resource, key, buffer, context), 'application/octet-stream');
    await client.query('UPDATE notebook_sources SET storage_key = $2 WHERE id = $1', [row.id, key]);
    files.replaced.push(row.storage_key);
}

async function removeFiles(keys) {
    await Promise.all(keys.map((key) => storage().deleteFile(key).catch((e) => {
        require('../../telemetry/log').warn('[DocumentSharing] Could not clean up a replaced source file:', e.message);
    })));
}

module.exports = { openBuffer, sealBuffer, readBuffer, transition, removeFiles };
