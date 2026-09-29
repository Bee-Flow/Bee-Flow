/**
 * Webpage AI message builder — shared by the authenticated preview bridge
 * (server/routes/webpagesPreview.js) and the anonymous public-share bridge
 * (server/routes/publicShareBridge.js).
 *
 * Given an author context (from webpageBridgeAuth.loadAuthorContext) and a
 * request body, produces the chat message array: a system prompt describing the
 * embedded assistant, optional KB-grounding context, prior messages, and the
 * user prompt. Extracted so the two bridges cannot drift.
 *
 * The `groundGrantKey` option selects which grant flag gates KB grounding:
 *   - 'groundOnPage'        (in-app preview — authenticated author)
 *   - 'publicGroundOnPage'  (anonymous external share — separate opt-in, since
 *                            grounding inlines author KB into anonymous chats)
 */

const { searchWebpageKB } = require('./webpageKnowledgeSearch');
const log = require('../../telemetry/log');

/**
 * The author's Privacy Shield "own server" block list on the grounding
 * passages (BFSF-354): they reach the model without a tool call, and the same
 * passages fetched through page_knowledge_search are stripped too. The bridge
 * acts as the author, so it is the author's shield. Fails open, like every
 * result strip; a failed shield lookup leaves the list unapplied.
 */
async function stripOwnServerCategories(text, ctx) {
    let shield = null;
    try {
        shield = await require('../privacy/orgShield').resolveShieldFor({ orgId: ctx.authorOrgId || null, userId: ctx.authorUserId || null });
    } catch (e) {
        log.warn(`[WebpageBridgeAI] Shield lookup failed; own-server list not applied: ${e.message}`);
    }
    const { stripInjectedText } = require('../privacy/toolPiiGate');
    return stripInjectedText(text, { shield, tag: 'WebpageBridgeAI', what: 'grounding passages' });
}

async function buildAiMessages(ctx, body, { groundGrantKey = 'groundOnPage' } = {}) {
    const { webpage, authorUserId, bridgeGrants } = ctx;
    const prompt = typeof body.prompt === 'string' ? body.prompt : null;
    const messages = Array.isArray(body.messages) ? body.messages.slice() : null;
    if (!prompt && (!messages || messages.length === 0)) {
        throw new Error('prompt or messages is required');
    }

    const groundRequested = body.groundOnPage !== false;
    const groundEnabled = !!bridgeGrants.ai[groundGrantKey];
    const kbIds = Array.isArray(webpage.knowledgeBaseIds) ? webpage.knowledgeBaseIds : [];

    let kbContext = '';
    if (groundRequested && groundEnabled && kbIds.length > 0) {
        try {
            const queryText = prompt || (messages.length > 0 ? String(messages[messages.length - 1].content || '') : '');
            if (queryText.trim()) {
                const r = await searchWebpageKB({
                    userId: authorUserId, kbIds, query: queryText,
                    options: { topK: 6, rerank: true, minScore: 0.2 },
                });
                if (r?.contextPrompt) kbContext = await stripOwnServerCategories(r.contextPrompt, ctx);
            }
        } catch (err) {
            log.warn(`[WebpageBridgeAI] KB search failed: ${err.message}`);
        }
    }

    const systemBits = [
        `You are an AI assistant embedded inside the webpage "${webpage.name}".`,
        `Answer the user's request concisely. The user's webpage runs sandboxed; do not produce links or code that assumes same-origin fetches.`,
    ];
    if (webpage.description) systemBits.push(`Page description: ${webpage.description}`);
    if (webpage.instructions) systemBits.push(`Custom instructions from the author: ${webpage.instructions}`);
    if (kbContext) systemBits.push(`\n${kbContext}`);

    const out = [{ role: 'system', content: systemBits.join('\n\n') }];
    if (messages) {
        for (const m of messages) {
            if (!m || typeof m.content !== 'string') continue;
            if (m.role === 'user' || m.role === 'assistant') {
                out.push({ role: m.role, content: m.content });
            }
        }
    }
    if (prompt) out.push({ role: 'user', content: prompt });
    return out;
}

module.exports = { buildAiMessages };
