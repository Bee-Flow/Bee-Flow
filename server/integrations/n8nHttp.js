// @typecheck noImplicitAny
'use strict';
/**
 * The one fetch the n8n integration uses.
 *
 * Certificates are verified by default. A self-signed or internal n8n instance
 * opts in with N8N_ALLOW_INSECURE_TLS=1, and only then, and only for https
 * calls made here: the API key and the workflow payloads travel over this
 * socket, so verification is never switched off process-wide. Node's own fetch
 * takes no TLS option, so the opt-in path goes through undici directly.
 */

const { fetch: undiciFetch, Agent } = require('undici');

// Read once, at load: a security default is not something a request may flip.
// `=== '1'` and nothing looser, so "0" and "false" keep verification on.
const N8N_ALLOW_INSECURE_TLS = process.env.N8N_ALLOW_INSECURE_TLS === '1';

/** @type {import('undici').Agent | null} */
let insecureAgent = null;

function allowInsecureTls() {
    return N8N_ALLOW_INSECURE_TLS;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
function n8nFetch(url, init = {}) {
    if (!N8N_ALLOW_INSECURE_TLS || !String(url).startsWith('https://')) return fetch(url, init);
    // HTTP/1.1 only, as before undici 8 (which offers h2 by default).
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- operator opt-in (N8N_ALLOW_INSECURE_TLS=1, exactly '1') for a self-signed n8n; verification stays on otherwise
    insecureAgent ||= new Agent({ allowH2: false, connect: { rejectUnauthorized: false } });
    // Node's global fetch IS undici; its RequestInit only differs by the duplicated undici-types package.
    return undiciFetch(url, /** @type {import('undici').RequestInit} */ ({ ...init, dispatcher: insecureAgent }));
}

/**
 * A multipart body from plain fields and buffers, as n8n's webhook expects.
 * @param {Record<string, unknown>} [fields]
 * @param {Array<{ content: Buffer | string, encoding?: BufferEncoding, fieldName?: string, mimeType?: string, name?: string }>} [files]
 */
function multipartBody(fields = {}, files = []) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const file of files) {
        const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, file.encoding || 'base64');
        form.append(file.fieldName || 'file', new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)], { type: file.mimeType || 'application/octet-stream' }), file.name);
    }
    return form;
}

module.exports = { n8nFetch, multipartBody, allowInsecureTls };
