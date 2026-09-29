/**
 * What ONE round of the agentic loop sends, and down which branch.
 *
 * Per round (not per turn), because almost everything here changes between
 * rounds: the transcript has grown by an assistant message and a tool result,
 * the first round is the only one that may process attachments, a guardrail
 * addendum applies to the first round alone, the PII token list grows as the
 * conversation does, and the wrap-up round has to flatten the tool round-trips
 * out of the history because it is sent with no tools defined.
 *
 * It ends on the branch decision — SDK adapter (and every self-hosted runtime)
 * or the raw OpenAI-compatible SSE path — which the caller then dispatches on.
 *
 * Moved verbatim out of chatStream.js.
 */
const { getAdapter } = require('../../providers');
// Pulled from the leaf modules, not the providers index: the runtime's tests
// mock '../../providers' down to { getAdapter }, and the index would also drag
// every SDK into a test that only needs the type predicate.
const { isLocalProviderType } = require('../../providers/localModels');
const LocalProvider = require('../../providers/local');
require('../../../utils/messageUtils');
const { buildTokenPreservationAddendum } = require('../../dlp/tokenPreservationPrompt');
const { processTurnAttachments } = require('../attachmentIntake');
const { _flattenToolRoundTrips } = require('../toolRoundExecutor');

async function buildRoundRequest({
    agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
    messages, iterations, persistedByLive, dlpShield, onEvent,
    systemPrompt, volatileSystemPrompt, guardrailViolation, moderationViolation,
    _forceFinalAnswer, _assistantTokenisationInfo,
}) {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = config.apiKey;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Build API URL - handle providers with /v1 in URL
    let apiUrl = config.url.replace(/\/$/, '');
    if (!apiUrl.endsWith('/v1')) {
        apiUrl = `${apiUrl}/v1`;
    }

    // Process Attachments (PDFs, Images)
    const processedMessages = [...messages];
    // Only the FIRST iteration's last message is the user turn; from the
    // second round on it is the newest tool result (`messages` grows by
    // an assistant message + one toolMsg per round).
    const lastMsg = processedMessages[processedMessages.length - 1];

    // Handle attachments if present — FIRST ITERATION ONLY.
    // processAttachments() hydrates the extracted text (and image_url
    // blocks) onto `lastMsg` in place, and that object stays in
    // `messages`, so every later round already carries the content.
    // Re-running it would target the newest tool-result message
    // instead: it would inline the whole attachment into a role-`tool`
    // message that is shared with durableMessages (→ written to
    // Postgres by persistDurable), duplicate the attachment text into
    // the prompt once per tool round, and re-run the paid extraction
    // chain (pdfjs → Azure DI → Mistral OCR), the RustFS image upload
    // and the DLP attachment scan every single round.
    if (iterations === 1 && messageMetadata?.attachments && messageMetadata.attachments.length > 0) {
        _assistantTokenisationInfo = await processTurnAttachments({ messageMetadata, lastMsg, userId, modelToUse, persistedByLive, dlpShield, conversation, onEvent, agent, agentId, config, _assistantTokenisationInfo });
    }

    // Inject guardrail violation context if detected. These addenda are
    // per-turn, so they go on the volatile half — appending them to the
    // cached half would rebuild the whole prefix on any flagged turn.
    const effectiveSystemPrompt = systemPrompt;
    let effectiveVolatilePrompt = volatileSystemPrompt;
    if (guardrailViolation && iterations === 1) {
        effectiveVolatilePrompt += `\n\n[IMPORTANT: The user's message was blocked by guardrail rule(s): "${guardrailViolation}". You must politely decline to process this request and explain that the content violates the "${guardrailViolation}" policy. Do not attempt to answer the request.]`;
        // Strip the violating user message — only send a placeholder to the model
        const lastIdx = messages.length - 1;
        if (messages[lastIdx]?.role === 'user') {
            messages[lastIdx] = { ...messages[lastIdx], content: `[Message blocked by guardrail: ${guardrailViolation}]` };
        }
    }
    if (moderationViolation && iterations === 1) {
        effectiveVolatilePrompt += `\n\n[IMPORTANT: The user's message was flagged by content moderation for: "${moderationViolation}". You must briefly explain that their message was flagged for "${moderationViolation}" and politely ask them to rephrase. Keep your response short (1-2 sentences). Do not process or answer the original request.]`;
        // Strip the violating user message — only send a placeholder to the model
        const lastIdx = messages.length - 1;
        if (messages[lastIdx]?.role === 'user') {
            messages[lastIdx] = { ...messages[lastIdx], content: `[Message flagged by content moderation: ${moderationViolation}]` };
        }
    }

    // PII tokens: tell the LLM to preserve & reuse them rather than invent new placeholders.
    // Reads the conversation-scoped accumulator so prior turns' tokens still apply.
    const _convTokenMap = require('../../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
    // The token list grows as the conversation goes on, so this must
    // stay off the cached half.
    const _tokenAddendum = buildTokenPreservationAddendum(_convTokenMap);
    if (_tokenAddendum) effectiveVolatilePrompt += _tokenAddendum;

    // On the wrap-up round the tool list is withheld, so the tool
    // round-trips have to come out of the transcript too — a request that
    // carries tool_use/tool_result blocks with no tools defined is
    // invalid (see `_flattenToolRoundTrips`). Every other round sends the
    // history untouched.
    const finalMessages = _forceFinalAnswer
        ? _flattenToolRoundTrips(processedMessages)
        : processedMessages;

    // Sanitize messages — Mistral rejects extra fields like parentId, id, etc.

    const _streamCallStart = Date.now();

    // ─── Resolve tier settings for thinking/temperature config ─────
    let tierSettings = {};
    if (agent.model && agent.model.startsWith('tier:')) {
        const tierName = agent.model.substring(5);
        const { getTierConfig } = require('../../llm/modelResolver');
        tierSettings = await getTierConfig(tierName, { userOrgId: messageMetadata?.userOrgId || null });
    }

    // ─── Adapter streaming (SDK providers + self-hosted runtimes) ─────
    // The self-hosted flavours used to fall through to the raw-fetch
    // path below, which builds its own body: no max_tokens, no
    // enable_thinking / reasoning_effort / top_k, no late-system fold,
    // and it joined the two system halves back into one — so an
    // agent turn on llama.cpp lost every knob the tier UI sets AND
    // re-read the whole prompt every turn. LocalProvider.stream has
    // all of that; the two things the raw path had that the adapter
    // lacked (client-abort propagation, a hard stall timeout) are
    // passed in as adapterOptions.signal / timeoutMs below.
    const providerAdapter = getAdapter(config.providerType, config.url);
    // EU GPT has no /chat/completions at all, so the raw path cannot reach it.
    const NATIVE_TYPES = ['google', 'openai', 'claude', 'mistral', 'azure', 'google-vertex', 'eugpt'];
    const _adapterIsLocal = isLocalProviderType(config.providerType) || providerAdapter instanceof LocalProvider;
    const useNativeAdapter = (NATIVE_TYPES.includes(config.providerType) || _adapterIsLocal) && typeof providerAdapter?.stream === 'function';

    return {
        headers, apiUrl, processedMessages, finalMessages,
        effectiveSystemPrompt, effectiveVolatilePrompt, tierSettings,
        providerAdapter, useNativeAdapter, _adapterIsLocal,
        _streamCallStart, _assistantTokenisationInfo,
    };
}

module.exports = { buildRoundRequest };
