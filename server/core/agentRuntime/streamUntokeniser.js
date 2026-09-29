/**
 * Streaming agent chat — DLP un-tokeniser event wrapper.
 *
 * Wraps the turn's onEvent so redacted [person_N]/[email_N] tokens are
 * restored to real values in every content / content_replace / thinking
 * frame before it reaches the client, and (when the org opted into
 * showRawPayload) accumulates the raw pre-restore response for the "How I
 * got this answer" panel. Moved verbatim out of chatStream.js; the caller
 * swaps its own onEvent for the returned one and reads the raw buffer back
 * at end of turn via getRawResponseBuffer().
 */
function createUntokenisingEventWrapper({ onEvent, dlpShield, conversation }) {
    // ── DLP un-tokeniser (wraps onEvent for the rest of the turn) ──
    // If the conversation has any redacted tokens (from this turn or an earlier
    // one), transparently replace them with the real values in every `content`
    // chunk before it hits the client. Any other event is forwarded unchanged.
    //
    // When the org enables `showRawPayload`, we also accumulate the *raw*
    // (pre-un-tokenise) response text so we can emit `privacy_response_raw` at
    // the end of the turn. That lets the "How I got this answer" panel show the
    // exact string the LLM produced.
    let _rawResponseBuffer = '';
    const _captureRaw = !!dlpShield?.showRawPayload;
    const RAW_BUFFER_MAX = 256 * 1024; // cap at 256 KB per turn, then truncate.
    // Hoisted so the assistant-message build step can read which tokens were
    // actually restored in this turn's response and surface the "Privacy
    // protection" panel even when no new redaction fired.
    let _ut = null;
    {
        const _dlpRunner = require('../dlp/dlpRunner');
        const _dlpConvMap = _dlpRunner.getConversationTokenMap(conversation?.id);
        // Wrap the un-tokeniser whenever (a) the conv map already has tokens,
        // OR (b) the org has PII detection enabled — because in that case the
        // attachment scanner (which runs LATER in processAttachments) may add
        // tokens that still need to be reversed on the response stream. The
        // un-tokeniser uses a live getter so it picks up those late-added tokens.
        const _piiMayFire = !!(dlpShield && dlpShield.enabled);
        const _shouldWrapUntokeniser = (_dlpConvMap && Object.keys(_dlpConvMap).length > 0) || _piiMayFire;
        if (_shouldWrapUntokeniser) {
            const { createUntokeniser } = require('../dlp/untokeniseStream');
            _ut = createUntokeniser(() => _dlpRunner.getConversationTokenMap(conversation?.id));
            const _rawOnEvent = onEvent;
            onEvent = (type, data) => {
                if (type === 'content' && data && typeof data.text === 'string') {
                    if (_captureRaw && _rawResponseBuffer.length < RAW_BUFFER_MAX) {
                        _rawResponseBuffer += data.text;
                        if (_rawResponseBuffer.length > RAW_BUFFER_MAX) {
                            _rawResponseBuffer = _rawResponseBuffer.slice(0, RAW_BUFFER_MAX) + '…';
                        }
                    }
                    const safe = _ut.push(data.text);
                    if (safe) _rawOnEvent(type, { ...data, text: safe });
                    return;
                }
                // On any non-content event (tool-call, thinking, done-ish), flush
                // whatever is buffered so we never leave a partial token dangling.
                const tail = _ut.flush();
                if (tail) _rawOnEvent('content', { text: tail });
                // `content_replace` overwrites the whole rendered assistant
                // message on the client (useChatEngine sets contentRef from
                // data.text), so it needs the same restore as `content`.
                // Forwarding it verbatim replaced a bubble that had just
                // streamed real values with one full of [person_1]/[email_1]
                // placeholders — the end-of-turn XML/think-tag strip fires this
                // on every OSS/generic-endpoint turn. Same class as the
                // `thinking` fix below (BFSF-253); directChat.js:3688 restores
                // before its content_replace for exactly this reason. Storage
                // stays tokenised — only the display copy is restored.
                //
                // NOT via `_ut.restore()`: that shares the `replacedTokens` ledger
                // with `push()`, and this text is a cleaned copy of content already
                // streamed (and already counted) chunk by chunk — re-running the
                // substitution over it counted every echo twice and inflated the
                // "Privacy protection" panel. `restoreTokens` is the same
                // drift-tolerant substitution with no accounting side effect; it is
                // what the persisted thinking/toolHistory passes below already use.
                if (type === 'content_replace' && data && typeof data.text === 'string') {
                    const { restoreTokens } = require('../privacy/piiDetection');
                    const _mapForReplace = _dlpRunner.getConversationTokenMap(conversation?.id) || {};
                    _rawOnEvent(type, { ...data, text: restoreTokens(data.text, _mapForReplace) });
                    return;
                }
                // Restore PII tokens in the model's reasoning too. The thinking
                // panel is user-visible, so placeholder tokens like [email_1] (and
                // any redacted artefacts) must be reversed here just as for content,
                // or they leak the token mechanics into the UI (BFSF-253).
                if (type === 'thinking' && data && typeof data.text === 'string') {
                    _rawOnEvent(type, { ...data, text: _ut.restore(data.text) });
                    return;
                }
                _rawOnEvent(type, data);
            };
        } else if (_captureRaw) {
            // No token map (no redaction happened) — we still want to capture the
            // raw response so the admin / user can inspect "what the AI said"
            // even when tokenisation didn't fire this turn. Minimal wrapper.
            const _rawOnEvent = onEvent;
            onEvent = (type, data) => {
                if (type === 'content' && data && typeof data.text === 'string') {
                    if (_rawResponseBuffer.length < RAW_BUFFER_MAX) {
                        _rawResponseBuffer += data.text;
                        if (_rawResponseBuffer.length > RAW_BUFFER_MAX) {
                            _rawResponseBuffer = _rawResponseBuffer.slice(0, RAW_BUFFER_MAX) + '…';
                        }
                    }
                }
                _rawOnEvent(type, data);
            };
        }
    }

    return { onEvent, _ut, _captureRaw, getRawResponseBuffer: () => _rawResponseBuffer };
}

module.exports = { createUntokenisingEventWrapper };
