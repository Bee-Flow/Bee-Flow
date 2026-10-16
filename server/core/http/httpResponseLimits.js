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
 * Before this module existed, both surfaces independently defined their own
 * `1024 * 1024` and stayed in sync only by a comment saying so. One
 * constant means they cannot drift apart again.
 */
'use strict';

const HTTP_RESPONSE_CAP = 1024 * 1024;

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
 * @param {Response} resp
 * @param {{charCap?: number, stopOnOversizeHeader?: boolean}} [opts]
 * @returns {Promise<{text: string, truncated: boolean}>} `text` is at most
 *   `charCap` characters; `truncated` is true when the body was longer.
 */
async function readBodyBounded(resp, { charCap = HTTP_RESPONSE_CAP, stopOnOversizeHeader = false } = {}) {
    const byteBudget = charCap * MAX_BYTES_PER_CHAR;
    const cancel = async () => { try { await resp.body?.cancel?.(); } catch { /* best effort */ } };

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

    const chunks = [];
    let received = 0;
    let overBudget = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > byteBudget) {
            overBudget = true;
            try { await reader.cancel(); } catch { /* best effort */ }
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

module.exports = { HTTP_RESPONSE_CAP, MAX_BYTES_PER_CHAR, readBodyBounded };
