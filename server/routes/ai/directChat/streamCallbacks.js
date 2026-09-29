/**
 * Direct Chat — the two adapter stream callbacks of a turn.
 *
 * `primary` runs the first streamed round; `follow` runs every wrap-up
 * kickstart and tool follow-up. They are deliberately not identical: only the
 * primary saves generated images and captures adapter usage, and only the
 * follow-up goes through the display-segment separator. Both accumulate onto
 * the TurnState, so the loops in streamTurn.js read the live values. Moved
 * verbatim out of streamTurn.js.
 */

const { makeStreamCallback } = require('./toolExec');
const { createDisplaySegments } = require('./displaySegments');
const { extractPartialJsonString } = require('./shared');
const log = require('../../../telemetry/log');

/**
 * The streaming un-tokeniser and the two sinks built on it.
 *
 * Without it, content chunks containing `[person_N]` tokens flash to the user
 * as raw placeholders until the end-of-stream `content_replace` swaps them.
 * Each chunk now passes through a buffered un-tokeniser that holds a `[…`
 * tail until the closing `]` arrives, then replaces in place. The map is read
 * through a LIVE getter so tokens added mid-turn are picked up.
 */
function createUntokeniserSink(turn) {
    const { send } = turn;
    const { createUntokeniser: _createUntok } = require('../../../core/dlp/untokeniseStream');
    const _dlpRunnerForStream = require('../../../core/dlp/dlpRunner');
    turn._streamUntok = _createUntok(() => _dlpRunnerForStream.getConversationTokenMap(turn.convId));
    turn.streamContent = (text) => {
        if (!text) return;
        const safe = turn._streamUntok.push(text);
        if (safe) send('content', { text: safe });
    };
    // Call at end-of-stream so any trailing partial token tail is released.
    // The end-of-stream restoration also runs a full-text `restoreTokens` as a
    // safety net, so a missed flush delays a replacement by one event rather
    // than leaking a token.
    turn.streamContentFlush = () => {
        const tail = turn._streamUntok.flush();
        if (tail) send('content', { text: tail });
    };
}

function getThinkingPart(turn, partId) {
    if (!partId) return null;
    let part = turn.thinkingParts.find(p => p.id === partId);
    if (!part) {
        part = { id: partId, text: '', startedAt: Date.now(), endedAt: null };
        turn.thinkingParts.push(part);
    }
    return part;
}

/**
 * Replay-shaped copy of the reasoning streamed since the last snapshot.
 * Only parts that can actually be sent back matter: a signed thinking
 * block, or a redacted block with its opaque payload.
 */
function snapshotThinkingParts(turn) {
    const slice = turn.thinkingParts.slice(turn.thinkingSnapshotFrom);
    turn.thinkingSnapshotFrom = turn.thinkingParts.length;
    const replayable = slice
        // A signature alone is enough: under `display: 'omitted'` the text
        // is empty and the signature carries the reasoning.
        .filter(p => p.signature || (p.redacted && p.redactedData))
        .map(p => ({
            id: p.id,
            text: p.text,
            redacted: p.redacted || undefined,
            signature: p.signature || undefined,
            redactedData: p.redactedData || undefined,
        }));
    return replayable.length > 0 ? replayable : undefined;
}

/**
 * As notebook_write's `content` argument streams in, push throttled partial
 * updates to the Notebook panel so the user watches the document being
 * written instead of it popping in fully-formed at the end. Only
 * Claude/OpenAI/Mistral stream partial tool args; Gemini delivers them
 * complete, so there the panel just fills in once at tool completion.
 */
function maybeStreamNotebook(turn, toolName, partialArgs) {
    if (!turn.canUseNotebooks || toolName !== 'notebook_write') return;
    const content = extractPartialJsonString(partialArgs, 'content');
    if (!content) return;
    const now = Date.now();
    // Throttle: emit only when it grew enough or enough time elapsed, so
    // we stream smoothly without flooding the SSE channel.
    if (content.length - turn._nbStreamLastLen < 24 && now - turn._nbStreamLastAt < 120) return;
    turn._nbStreamLastLen = content.length;
    turn._nbStreamLastAt = now;
    turn.send('workspace_update', { content, streaming: true });
}

// Google image models hand the image back on the stream — persist it so the
// reply can still render it after a reload.
function persistStreamedImage(turn, data) {
    const { send, userId } = turn;
    const imgEntry = { data: data.data, mimeType: data.mimeType };
    turn.generatedImages.push(imgEntry);
    send('image', { data: data.data, mimeType: data.mimeType });
    // Save to RustFS or local disk for persistence
    try {
        const storageStore = require('../../../stores/storageStore');
        const crypto = require('crypto');
        const ext = (data.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        if (storageStore.isAvailable() && data.data) {
            const key = storageStore.buildKey(userId, 'images', filename);
            storageStore.uploadFile(key, Buffer.from(data.data, 'base64'), data.mimeType || 'image/png')
                .then(() => { imgEntry.url = storageStore.buildProxyUrl(key); imgEntry.storageKey = key; })
                .catch(e => log.warn('[DirectChat] Failed to save inline image to RustFS:', e.message));
        } else if (data.data) {
            // Fallback: local disk (synchronous — URL available for DB save)
            const genDir = require('path').join(__dirname, '..', '..', '..', 'data', 'uploads', 'generated');
            if (!require('fs').existsSync(genDir)) require('fs').mkdirSync(genDir, { recursive: true });
            require('fs').writeFileSync(require('path').join(genDir, filename), Buffer.from(data.data, 'base64'));
            imgEntry.url = `/uploads/generated/${filename}`;
        }
    } catch (e) { /* ignore */ }
}

function createStreamCallbacks(turn) {
    const { send } = turn;
    // BFSF-261: pre-tool preamble text used to glue against the follow-up
    // round on the client ("…anything." + "Good, I have…") and vanish from
    // persistence (only the last round's text was saved). Segments record
    // each round's visible text; a lazy separator keeps the live view
    // readable and joinFinal() makes storage match the stream.
    turn.displaySegments = createDisplaySegments();
    turn.getThinkingPart = (partId) => getThinkingPart(turn, partId);
    turn.maybeStreamNotebook = (toolName, partialArgs) => maybeStreamNotebook(turn, toolName, partialArgs);

    const shared = {
        send,
        getThinkingPart: turn.getThinkingPart,
        maybeStreamNotebook: turn.maybeStreamNotebook,
        streamUntok: turn._streamUntok,
        isMuted: () => turn.muteAssistantText,
        appendContent: (t) => { turn.fullContent += t; },
        appendThinking: (t) => { turn.thinkingContent += t; },
        getThinkingParts: () => turn.thinkingParts,
        pushToolCall: (tc) => turn.streamToolCalls.push(tc),
        setLastResponseId: (id) => { turn.lastResponseId = id; },
    };

    const primary = makeStreamCallback({
        ...shared,
        streamContent: turn.streamContent,
        acceptToolCallEvents: false,
        // Image persistence policy stays at this call site: only the
        // primary stream saves generated images (the follow-up stream
        // historically dropped image events).
        onImage: (data) => persistStreamedImage(turn, data),
        onUsage: (data) => {
            turn.streamUsage = data;
            // llama-server's own numbers: cache_n/prompt_n is the prefix-cache
            // hit rate for THIS request — the measurement the whole prompt
            // layout is built around.
            const t = data?.timings;
            if (t && typeof t === 'object') {
                log.info(`[DirectChat] llama timings prompt_n=${t.prompt_n} cache_n=${t.cache_n} prompt_ms=${t.prompt_ms} predicted_n=${t.predicted_n} predicted_ms=${t.predicted_ms}`);
            }
        },
        responseIdLog: '[DirectChat] Captured responseId for chaining:',
    });

    // Follow-up drift kept as-is: raw 'tool_call' events are accepted,
    // image events are dropped (onImage: null) and adapter usage is not
    // captured (onUsage: null) — matching the historical followStreamCallback.
    const follow = makeStreamCallback({
        ...shared,
        // Wrapped sink: emits one lazy '\n\n' before the first visible
        // text of a new round (BFSF-261). ONLY the follow-up callback is
        // wrapped — the primary stream above keeps the raw streamContent.
        streamContent: turn.displaySegments.wrapStreamContent(turn.streamContent, send),
        acceptToolCallEvents: true,
        onImage: null,
        onUsage: null,
        responseIdLog: '[DirectChat] Updated lastResponseId after tool follow-up:',
    });

    return { primary, follow };
}

module.exports = { createUntokeniserSink, createStreamCallbacks, snapshotThinkingParts };
