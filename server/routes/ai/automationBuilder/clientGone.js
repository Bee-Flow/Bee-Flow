// @typecheck strict
/**
 * "The client closed the stream" for the builder's POST streams (chatStream.js,
 * layerAgent.js).
 *
 * The signal has to come from the RESPONSE. A request's own 'close' is emitted
 * as soon as its body has been read, which for a POST with a JSON body is
 * before the handler runs: a listener attached in the handler is never called,
 * and the build loop went on calling the model for a tab that was gone. (A GET
 * has no body to finish, which is why the same listener does work there.)
 *
 * Our own res.end() emits 'close' too; `writableEnded` tells the two apart.
 */

'use strict';

/**
 * Call `onGone` once when the client goes away before the response has ended.
 * @param {unknown} _req  not listened to (see above); in the signature so the call site reads as what it replaces
 * @param {Pick<import('http').ServerResponse, 'on' | 'writableEnded'>} res
 * @param {() => void} onGone
 */
function onClientGone(_req, res, onGone) {
    // A handler driven with a plain object for a response has no events
    // (openSse in core/http/sseHelpers.js makes the same allowance).
    if (typeof res.on !== 'function') return;
    let told = false;
    res.on('close', () => {
        if (told || res.writableEnded) return;
        told = true;
        onGone();
    });
}

module.exports = { onClientGone };
