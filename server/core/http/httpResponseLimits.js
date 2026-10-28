// @typecheck strict
/**
 * Shared ceiling for an outbound HTTP response body (character count of the
 * decoded text — called a "1 MiB" cap throughout, though it is really a
 * character count rather than a byte count).
 *
 * Two surfaces fetch an outbound HTTP response and both must cap its size,
 * but they sit on different sides of a trust boundary and so react to
 * hitting the cap differently:
 *
 *   - core/automationRunner/execOutbound.js's execHttpRequest — the
 *     declarative `http_request` step. A response over this cap THROWS
 *     (BFSF-436): a truncated body is invalid JSON by construction, and
 *     handing that back under an ordinary `success` status — with the
 *     documented "add a Parse JSON step" workaround unable to do anything
 *     with it — is worse than a clear, actionable failure.
 *   - automation/codeSandbox.js's defaultFetchHttp — the code step's own
 *     `ctx.http()` bridge (and, transitively,
 *     integrations/webpageApiRuntime.js's fetchHttp, which forwards to it
 *     unchanged). That surface hands the response to code the user wrote
 *     themselves, a different trust boundary than a declarative step
 *     silently discarding the cut — it keeps returning
 *     `{ truncated: true }` to the caller's own code instead of throwing.
 *
 * One constant for both surfaces, rather than each defining its own
 * `1024 * 1024` and staying in sync only by a comment saying so, means they
 * cannot drift apart.
 */
'use strict';

const { bestEffort } = require('../../utils/bestEffort');

const HTTP_RESPONSE_CAP = 1024 * 1024;

/**
 * Cancel a body or reader we are done with; a failure to cancel changes nothing for the caller.
 * @param {{ cancel?: () => Promise<unknown> } | null | undefined} target  a body stream or its reader, from either fetch implementation
 */
async function cancelQuietly(target) {
    try { await target?.cancel?.(); } catch (e) { bestEffort('core/http/httpResponseLimits:cancelQuietly', e); /* [httpResponseLimits] cancel failed: */ }
}

// Longest UTF-8 encoding of one character. A body of at most cap*4 bytes can be
// decoded and measured exactly in characters; anything past that budget is
// certainly over the cap, so the read stops there instead of buffering it all.
const MAX_BYTES_PER_CHAR = 4;

/**
 * Read a fetch Response body without ever holding more than the byte budget
 * (BFSF-460). Streams, cancels the stream once the budget is passed, and with
 * `stopOnOversizeHeader` skips the body entirely when Content-Length already
 * declares more than the budget.
 *
 * @param {FetchResponse} resp
 * @param {{charCap?: number, stopOnOversizeHeader?: boolean}} [opts]
 * @returns {Promise<{text: string, truncated: boolean}>} `text` is at most
 *   `charCap` characters; `truncated` is true when the body was longer.
 */
async function readBodyBounded(resp, { charCap = HTTP_RESPONSE_CAP, stopOnOversizeHeader = false } = {}) {
    const byteBudget = charCap * MAX_BYTES_PER_CHAR;
    const cancel = async () => { try { await resp.body?.cancel?.(); } catch (err) { bestEffort('core/http/httpResponseLimits:cancel', err); /* best effort */ } };

    // No body at all (HEAD, 204, 304): Content-Length describes the resource, not
    // anything we would read, so there is nothing to bound or to call oversize.
    if (resp.body === null) return { text: '', truncated: false };

    const declared = Number(resp.headers?.get?.('content-length'));
    if (stopOnOversizeHeader && Number.isFinite(declared) && declared > byteBudget) {
        await cancel();
        return { text: '', truncated: true };
    }

    const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
    if (!reader) {
        // No stream to bound (a test double): fall back to text().
        const text = await resp.text();
        return text.length > charCap ? { text: text.slice(0, charCap), truncated: true } : { text, truncated: false };
    }

    /** @type {Uint8Array<ArrayBuffer>[]} */
    const chunks = [];
    let received = 0;
    let overBudget = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > byteBudget) {
            overBudget = true;
            try { await reader.cancel(); } catch (err) { bestEffort('core/http/httpResponseLimits:readBodyBounded', err); /* best effort */ }
            break;
        }
        chunks.push(value);
    }
    // TextDecoder, not Buffer#toString: like Response#text() it strips a leading
    // UTF-8 BOM, so a body that starts with one still parses as JSON.
    const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
    if (overBudget || text.length > charCap) return { text: text.slice(0, charCap), truncated: true };
    return { text, truncated: false };
}

/**
 * Read a size limit from an env var: unset or invalid -> `fallback`, 0 (or a
 * negative number) -> Infinity ("no cap"). Read at call time so an admin change
 * after a restart and tests that set the variable both work.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function envByteLimit(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return n <= 0 ? Infinity : Math.floor(n);
}

const DEFAULT_TOOL_FILE_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_KB_WEB_PAGE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KB_SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

/** Largest file a tool (Nextcloud, mail, Gmail) downloads into memory. TOOL_FILE_MAX_BYTES, 0 = no cap. */
const toolFileMaxBytes = () => envByteLimit('TOOL_FILE_MAX_BYTES', DEFAULT_TOOL_FILE_MAX_BYTES);
/** Largest web page a knowledge-base crawl reads. KB_WEB_PAGE_MAX_BYTES, 0 = no cap. */
const kbWebPageMaxBytes = () => envByteLimit('KB_WEB_PAGE_MAX_BYTES', DEFAULT_KB_WEB_PAGE_MAX_BYTES);
/** Largest sitemap a knowledge-base crawl reads. KB_SITEMAP_MAX_BYTES, 0 = no cap. */
const kbSitemapMaxBytes = () => envByteLimit('KB_SITEMAP_MAX_BYTES', DEFAULT_KB_SITEMAP_MAX_BYTES);

/**
 * Read a fetch Response body as a Buffer without holding more than `byteCap`
 * bytes. Content-Length over the cap cancels the body unread; otherwise the
 * stream is cancelled as soon as the running total passes the cap. A cap of 0
 * or Infinity reads everything.
 *
 * @param {FetchResponse} resp
 * @param {{byteCap?: number}} [opts]
 * @returns {Promise<{buffer: Buffer|null, truncated: boolean, declaredBytes: number|null}>}
 *   `buffer` is null when `truncated`; `declaredBytes` is Content-Length when sent.
 */
async function readBytesBounded(resp, { byteCap = Infinity } = {}) {
    const cap = !byteCap || byteCap <= 0 ? Infinity : byteCap;
    const rawLen = resp.headers?.get?.('content-length');
    const declared = rawLen === null || rawLen === undefined || rawLen === '' ? NaN : Number(rawLen);
    const declaredBytes = Number.isFinite(declared) ? declared : null;

    if (resp.body === null) return { buffer: Buffer.alloc(0), truncated: false, declaredBytes };
    if (cap === Infinity) return { buffer: Buffer.from(await resp.arrayBuffer()), truncated: false, declaredBytes };
    if (declaredBytes !== null && declaredBytes > cap) {
        await cancelQuietly(resp.body);
        return { buffer: null, truncated: true, declaredBytes };
    }

    const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
    if (!reader) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        return buffer.length > cap ? { buffer: null, truncated: true, declaredBytes } : { buffer, truncated: false, declaredBytes };
    }
    /** @type {Buffer<ArrayBuffer>[]} */
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > cap) {
            await cancelQuietly(reader);
            return { buffer: null, truncated: true, declaredBytes };
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return { buffer: Buffer.concat(chunks), truncated: false, declaredBytes };
}

/**
 * Read a response as text for the knowledge base: never more than `byteCap`
 * bytes declared and, for a stream, about that many characters. Over the cap it
 * THROWS with a message naming the limit and `envName` (a partial page or
 * sitemap must not be indexed). A cap of Infinity (env value 0) reads everything.
 *
 * @param {FetchResponse} resp
 * @param {{byteCap: number, what: string, envName: string}} opts
 * @returns {Promise<string>}
 */
async function readTextOrThrowOversize(resp, { byteCap, what, envName }) {
    /**
     * @param {string} size
     */
    const tooBig = (size) => {
        const e = new Error(`${what} is too large to index (${size}; limit ${(byteCap / 1048576).toFixed(0)} MB). An admin can raise the limit with the ${envName} environment variable (0 = no limit).`);
        /** @type {any} */ (e).oversize = true;
        return e;
    };
    if (byteCap === Infinity) return resp.text();
    const declared = Number(resp.headers?.get?.('content-length'));
    if (resp.body !== null && Number.isFinite(declared) && declared > byteCap) {
        await cancelQuietly(resp.body);
        throw tooBig(`${(declared / 1048576).toFixed(1)} MB`);
    }
    const { text, truncated } = await readBodyBounded(resp, { charCap: byteCap, stopOnOversizeHeader: true });
    if (truncated) throw tooBig('larger than the limit');
    return text;
}

/**
 * A web page for the knowledge base, capped by KB_WEB_PAGE_MAX_BYTES (throws when over).
 * @param {FetchResponse} resp
 * @param {string} url
 */
const readKbPage
 = (resp, url) => readTextOrThrowOversize(resp, { byteCap: kbWebPageMaxBytes(), what: `Page ${url}`, envName: 'KB_WEB_PAGE_MAX_BYTES' });

/**
 * The message a tool answers with when a file is over the cap.
 * @param {string} name
 * @param {number | null} sizeBytes
 * @param {number} capBytes
 */
function fileTooLargeMessage(name, sizeBytes, capBytes) {
    const size = sizeBytes == null ? 'larger than the limit' : `${(sizeBytes / 1048576).toFixed(1)} MB`;
    return `${name} is too large to read (${size}; limit ${(capBytes / 1048576).toFixed(0)} MB). An admin can raise the limit with the TOOL_FILE_MAX_BYTES environment variable (0 = no limit).`;
}

module.exports = {
    HTTP_RESPONSE_CAP, MAX_BYTES_PER_CHAR, readBodyBounded,
    envByteLimit, toolFileMaxBytes, kbWebPageMaxBytes, kbSitemapMaxBytes,
    readBytesBounded, fileTooLargeMessage, readTextOrThrowOversize, readKbPage,
};

/**
 * A fetch Response from either implementation: the global one and undici's own
 * (what `guardedFetch` returns) are separate declarations that TypeScript does
 * not treat as assignable to each other.
 * @typedef {Response | import('undici-types').Response} FetchResponse
 */
