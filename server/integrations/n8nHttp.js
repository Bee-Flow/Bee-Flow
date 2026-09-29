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

let insecureAgent = null;

function allowInsecureTls() {
    return N8N_ALLOW_INSECURE_TLS;
}

function n8nFetch(url, init = {}) {
    if (!N8N_ALLOW_INSECURE_TLS || !String(url).startsWith('https://')) return fetch(url, init);
    insecureAgent ||= new Agent({ connect: { rejectUnauthorized: false } });
    return undiciFetch(url, { ...init, dispatcher: insecureAgent });
}

/** A multipart body from plain fields and buffers, as n8n's webhook expects. */
function multipartBody(fields = {}, files = []) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const file of files) {
        const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, file.encoding || 'base64');
        form.append(file.fieldName || 'file', new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }), file.name);
    }
    return form;
}

module.exports = { n8nFetch, multipartBody, allowInsecureTls };
