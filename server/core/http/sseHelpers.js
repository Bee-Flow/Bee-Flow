// @typecheck
/**
 * SSE Chat Helpers — Shared utilities for streaming chat routes
 * 
 * Extracts common SSE setup, abort handling, and title generation
 * boilerplate from agents.js.
 */

// `agentStore` is DB-backed and only needed by the conversation helpers below
// (persistAndTitle / getOrCreateAgentConversation). It's required lazily so
// that SSE-only callers — e.g. the automation builder route, which just wants
// startSseHeartbeat — don't drag in the store (and its DB pool) on load.

/**
 * Set up SSE streaming on a response object.
 * @param {Object} res - Express response
 * @returns {{ sendEvent: Function, abortController: AbortController, markEnded: Function }}
 */
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
function setupSSE(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const abortController = new AbortController();
    let responseEnded = false;

    res.on('close', () => {
        if (!responseEnded) {
            log.info('[SSE] Client disconnected — aborting');
            abortController.abort();
        }
    });

    const sendEvent = (event, data) => {
        if (!res.writableEnded && !abortController.signal.aborted) {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };

    const markEnded = () => {
        responseEnded = true;
    };

    return { sendEvent, abortController, markEnded };
}

/**
 * Keep a long, idle SSE stream alive through intermediaries.
 *
 * The Nextcloud AppAPI PHP proxy (and some gateways) idle-time-out a silent
 * connection, which 504'd long webpage/notebook builds and surfaced as a false
 * "Error generating response." in the chat (BFSF-221). Each beat writes TWO
 * frames: a comment frame (`: ping\n\n`) — kept for the Nextcloud AppAPI proxy
 * the original fix targeted — PLUS a real no-op `ping` event, so intermediaries
 * and clients whose idle timers reset on parsed *events* (not ignored comment
 * frames) also stay warm. Both are ignored by the client (EventSource skips the
 * comment; our fetch-based parser routes `ping` to a no-op in
 * useChatEngine.handleSSEEvent), so neither affects the event stream. Returns
 * stop() to clear the timer; it is also cleared automatically on res
 * close/finish/error.
 *
 * @param {Object} res - Express response (after headers are written)
 * @param {number} [intervalMs=10000]
 * @param {{ onDead?: Function, frame?: string, maxFailures?: number }} [opts]
 *   onDead — liveness callback fired when the stream is detected dead (the
 *     response already ended, or `maxFailures` consecutive write failures on a
 *     half-closed socket that never emitted 'close'). Lets event-bus streams
 *     tear down their listener even when 'close' never fires.
 *   frame — the exact bytes written per beat (default: a comment ping + a no-op
 *     `ping` event). Pass a custom frame to preserve a route's existing wire
 *     format (e.g. `': keepalive\n\n'`).
 *   maxFailures — consecutive write failures before onDead fires (default 3).
 * @returns {() => void} stop
 */
function startSseHeartbeat(res, intervalMs = 10000, opts = {}) {
    const { onDead = null, frame = ': ping\n\nevent: ping\ndata: {}\n\n', maxFailures = 3 } = opts;
    let timer = null;
    let failures = 0;
    const stop = () => {
        if (timer) { clearInterval(timer); timer = null; }
    };
    const die = () => { stop(); if (onDead) onDead(); };
    timer = setInterval(() => {
        try {
            if (res.writableEnded || res.destroyed) return die();
            res.write(frame);
            failures = 0;
        } catch (_e) {
            // Without an onDead handler, preserve the original behaviour: stop on
            // the first write error. With onDead, tolerate transient failures and
            // force cleanup once maxFailures consecutive writes fail (this is how
            // a half-closed socket that never fires 'close' gets reaped).
            if (!onDead) return stop();
            if (++failures >= maxFailures) return die();
        }
    }, intervalMs);
    if (timer.unref) timer.unref();  // don't keep the event loop alive for pings
    if (typeof res.on === 'function') {
        res.on('close', stop);
        res.on('finish', stop);
        res.on('error', stop);
    }
    return stop;
}

/** The head every hand-rolled stream used to write itself. */
const SSE_HEADERS = Object.freeze({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // nginx buffers a streamed response into uselessness without this.
    'X-Accel-Buffering': 'no',
});

/**
 * Open a streaming response: the SSE head, a guarded `send`, the client-stop
 * wiring and (opt-in) the keep-alive, in one call, so a route cannot forget
 * one of them.
 *
 *   - head: 200 + SSE_HEADERS. `headers` overrides single values (a `null`
 *     value drops that header), so a route keeps its exact wire head;
 *     `flush` pushes the head to the wire before the first event;
 *     `viaSetHeader` sets the head header by header (status stays 200)
 *     instead of writeHead, for a route that always wrote it that way;
 *     `charset` appends `; charset=…` to the Content-Type (what Express's
 *     res.set added for a route that used it);
 *   - send(event, data) / sendRaw(chunk): a no-op once the response has ended
 *     or the socket is gone, so a late callback never writes after end();
 *     a write that throws on a dying socket is swallowed;
 *   - signal / isGone(): the client closing the stream (the composer's stop
 *     button aborts the browser fetch) aborts `signal`. Our own end() also
 *     emits 'close', so `writableEnded` keeps it from reading as a cancel;
 *   - heartbeat: startSseHeartbeat, which keeps a long, silent turn alive
 *     through the Nextcloud AppAPI proxy instead of an idle 504 (BFSF-221).
 *     `true` for the default 10 s ping, or startSseHeartbeat's options plus
 *     `intervalMs` to keep a route's own interval and frame;
 *   - end(): stops the heartbeat and ends the response once (returns what
 *     res.end returns, or res when it had already ended).
 *
 * @param {Object} res - Express response (headers not yet sent)
 * @param {{ heartbeat?: boolean|{ intervalMs?: number, frame?: string, onDead?: Function, maxFailures?: number },
 *   intervalMs?: number, tag?: string|null, headers?: Object<string, string|null>, flush?: boolean,
 *   viaSetHeader?: boolean, charset?: string|null }} [opts]
 *   tag — when set, the disconnect is logged with this prefix (e.g. 'TemplateChat').
 * @returns {{ send: (event: string, data: any) => void, sendRaw: (chunk: string) => void,
 *   signal: AbortSignal, isGone: () => boolean, end: Function, stopHeartbeat: Function }}
 */
function openSse(res, opts = {}) {
    const { heartbeat = false, intervalMs = 10000, tag = null, headers = null, flush = false, viaSetHeader = false, charset = null } = opts;
    /** @type {Record<string, string>} */
    const head = { ...SSE_HEADERS };
    if (charset) head['Content-Type'] = `${head['Content-Type']}; charset=${charset}`;
    for (const [k, v] of Object.entries(headers || {})) {
        if (v === null || v === undefined) delete head[k]; else head[k] = v;
    }
    if (viaSetHeader) {
        for (const [k, v] of Object.entries(head)) res.setHeader(k, v);
    } else {
        res.writeHead(200, head);
    }
    if (flush && typeof res.flushHeaders === 'function') res.flushHeaders();
    const sendRaw = (chunk) => {
        if (res.writableEnded || res.destroyed) return;
        try { res.write(chunk); } catch (err) { bestEffort('core/http/sseHelpers:sendRaw', err); /* socket gone */ }
    };
    const send = (event, data) => sendRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const abortController = new AbortController();
    let gone = false;
    if (typeof res.on === 'function') {
        res.on('close', () => {
            if (res.writableEnded) return;
            gone = true;
            if (tag) log.info(`[${tag}] client disconnected — aborting the generation`);
            try { abortController.abort(); } catch (err) { log.debug('already aborted', err); }
        });
    }
    let stopHeartbeat = () => {};
    if (heartbeat) {
        const hb = typeof heartbeat === 'object' ? heartbeat : {};
        const { intervalMs: hbInterval = intervalMs, ...hbOpts } = hb;
        stopHeartbeat = startSseHeartbeat(res, hbInterval, hbOpts);
    }
    const end = (...args) => {
        stopHeartbeat();
        if (res.writableEnded) return res;
        return res.end(...args);
    };
    return { send, sendRaw, signal: abortController.signal, isGone: () => gone, end, stopHeartbeat };
}

/**
 * Send an SSE error and end the response (for limit errors etc.)
 * @param {Object} res - Express response
 * @param {string} error - Error message
 */
function sendSSEError(res, error) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
    res.end();
}

/**
 * Persist conversation messages and generate/update title.
 * Shared across terminal, security, and browser agent handlers.
 * 
 * @param {Object} options
 * @param {Object}  options.conversation   - Conversation object
 * @param {Array}   options.messages       - Messages array to persist
 * @param {string}  options.encryptionKey  - Encryption key
 * @param {string}  options.userId         - User ID
 * @param {string}  options.userMessage    - Original user message
 * @param {string}  options.orgId          - Organization ID
 * @param {Function} options.sendEvent     - SSE event sender
 * @param {Function} options.generateTitle - Title generation function (agentRuntime.generateChatTitle)
 * @param {boolean} [options.skipTitle]   - Keep the existing title
 */
async function persistAndTitle({ conversation, messages, encryptionKey, userId, userMessage, orgId, sendEvent, generateTitle, skipTitle }) {
    const agentStore = require('../../stores/agentStore');
    // Save conversation
    await agentStore.updateConversation(conversation.id, messages, encryptionKey, userId);

    // Title generation: deferred to the SECOND exchange (≥2 user and ≥2
    // assistant messages) and built from a tool-free transcript, so the title
    // reflects the real topic rather than a vague opening line. Idempotent —
    // only runs while the title is still a placeholder, so it's set once.
    const userMsgs = Array.isArray(messages) ? messages.filter(m => m && m.role === 'user').length : 0;
    const assistantMsgs = Array.isArray(messages) ? messages.filter(m => m && m.role === 'assistant').length : 0;
    const titleIsPlaceholder = !conversation.title || !String(conversation.title).trim()
        || /^new chat$/i.test(String(conversation.title).trim());
    if (userMsgs >= 2 && assistantMsgs >= 2 && titleIsPlaceholder && generateTitle && !skipTitle) {
        try {
            const transcript = _buildTitleTranscript(messages) || userMessage;
            const title = await generateTitle(transcript, null, orgId, userId);
            if (title && title !== 'New Chat') {
                await agentStore.updateConversationTitle(conversation.id, title);
                sendEvent('title_update', { title, conversationId: conversation.id });
            }
        } catch (e) { bestEffort('core/http/sseHelpers:persistAndTitle', e); /* ignore title gen errors */ }
    }
}

/**
 * Short, tool-free transcript (first two user+assistant exchanges) for title
 * generation — role + text only, no tool calls/results. Mirrors the direct-
 * chat titler so both surfaces title from the conversation, not just the
 * opening message.
 */
function _buildTitleTranscript(messages) {
    if (!Array.isArray(messages)) return '';
    const lines = [];
    let users = 0, assistants = 0;
    for (const m of messages) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        if (m.role === 'user' && users >= 2) continue;
        if (m.role === 'assistant' && assistants >= 2) continue;
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) {
            text = m.content
                .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text).join(' ');
        }
        text = (text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > 500) text = text.slice(0, 500);
        lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
        if (m.role === 'user') users++; else assistants++;
        if (users >= 2 && assistants >= 2) break;
    }
    return lines.join('\n');
}

/**
 * Get or create a conversation for a specialized agent.
 * Shared across terminal, security, and browser agent handlers.
 * 
 * @param {Object} agent - Agent object (id, name, description)
 * @param {string} conversationId - Existing conversation ID (or null)
 * @param {string} userId - User ID 
 * @param {string} encryptionKey - Encryption key
 * @returns {Promise<Object>} conversation
 */
async function getOrCreateAgentConversation(agent, conversationId, userId, encryptionKey) {
    const agentStore = require('../../stores/agentStore');
    // Ensure placeholder agent exists in agentStore for conversation persistence
    await agentStore.ensurePlaceholderAgent(agent.id, agent.name, agent.description);

    let conversation;
    if (conversationId) {
        conversation = await agentStore.getConversationById(conversationId, encryptionKey);
    }
    if (!conversation) {
        conversation = await agentStore.createNewConversation(agent.id, userId);
    }
    return conversation;
}

module.exports = { SSE_HEADERS, setupSSE, openSse, sendSSEError, startSseHeartbeat, persistAndTitle, getOrCreateAgentConversation };

/** @typedef {{ role?: string, content?: string | Array<{ type?: string, text?: unknown }> | null }} TitleMessage */
