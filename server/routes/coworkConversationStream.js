// @typecheck strict
const { setupSSE, startSseHeartbeat } = require('../core/http/sseHelpers');


// Only expose user-facing answer text. Partial routing JSON, reasoning and action arguments stay private.
/** @param {string} raw */
function partialAnswer(raw) {
    const prefix = /^\s*(?:```(?:json)?\s*)?\{\s*"action"\s*:\s*"(?!read_result"|find_tasks"|switch_task")[a-z_]+"\s*,\s*"answer"\s*:\s*"/i.exec(raw);
    if (!prefix) return '';
    const body = raw.slice(prefix[0].length);
    const tokens = /^(?:[^"\\\x00-\x1F]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/.exec(body);
    return JSON.parse('"' + (tokens?.[0] ?? '') + '"').slice(0, 2000);
}

/** @param {import('express').Response} res
 * @param {(stream?: {signal:AbortSignal,onText:(raw:string)=>void})=>Promise<unknown>} respond
 * @param {boolean} [answerOnly] */
async function sendConversation(res, respond, answerOnly = false) {
    res.setHeader('X-Accel-Buffering', 'no');
    const { sendEvent, markEnded, abortController } = setupSSE(res);
    const stop = startSseHeartbeat(res);
    let previous = '';
    try {
        const reply = await respond({ signal: abortController.signal, onText(raw) {
            if (answerOnly && !/^\s*(?:```(?:json)?\s*)?\{\s*"action"\s*:\s*"answer"/i.test(raw)) return;
            const text = partialAnswer(raw);
            if (text && text !== previous) sendEvent('answer', text);
            previous = text;
        } });
        sendEvent('reply', reply);
    } catch (err) {
        const { HttpError } = require('../core/http/errors');
        sendEvent('error', err instanceof HttpError ? err.message : 'Bee could not finish this reply. Please try again.');
    } finally {
        stop();
        markEnded();
        res.end();
    }
}
module.exports = { sendConversation, partialAnswer };
