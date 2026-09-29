/**
 * `POST /api/kb/:id/ask` — the Studio's test question.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────
 * "Does this knowledge base actually answer the question I built it for?" —
 * asked BEFORE an agent is pointed at it, by the person who assembled the
 * sources. That is a different question from chat, and it is why this is its
 * own route rather than a chat with one knowledge base attached: there is no
 * conversation, no tools, no memory, no persistence. One question, one answer,
 * and the passages it came from, so the answer can be checked against them.
 *
 * ── THE PASSAGES ARE DATA, NOT INSTRUCTIONS ─────────────────────────
 * The sources here are files somebody uploaded, pages somebody crawled, or a
 * folder that syncs. A crafted PDF saying "ignore the above" is a real path,
 * and this route asks a model a question with that text in the prompt. So it
 * uses the FENCED prompt (`core/kb/notebookKnowledgeSearch`'s form): every
 * passage is neutralised of markers that could impersonate our framing, fenced
 * in a `<source>` element, and preceded by the data-not-instructions rule
 * stated where the data appears — not the bare "here is some context"
 * concatenation that `routes/notebooks.js` uses for generation.
 *
 * ── THE ACCESS BOUNDARY IS THE ID LIST ──────────────────────────────
 * `quickKBSearch` does no tenant filtering of its own; the ids it is handed
 * ARE the boundary. So the id from the URL is authorised here, against the
 * person asking, before it goes anywhere near a search.
 *
 * ── SSE, AND WHY THE ORDER MATTERS ──────────────────────────────────
 *   kb_sources   the passages, FIRST — so the citations are on screen while
 *                the answer is still arriving, and a person can see the
 *                retrieval failed before reading a paragraph built on it
 *   text         the answer, streamed
 *   done         the end, with the token usage
 *   error        instead of `done`, when something failed
 *
 * `kb_sources` first is the whole point of a test question. An answer that
 * arrives before its sources invites reading the answer and trusting it.
 *
 * ── A QUESTION THAT IS TOO LONG IS REFUSED, NOT CUT ─────────────────
 * The body used to be `String(question).trim().slice(0, 2000)`. A pasted
 * customer e-mail of 3,000 characters was cut mid-sentence and answered, and
 * the person read the passages and the answer as a test of the whole thing.
 * `{ "question": { … } }` was asked as "[object Object]". Both are 400s now,
 * in words the Studio's error line shows — before any header goes out, which
 * is the only moment a status is still available on this route.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth } = require('../../auth');
const { canAccessKB, getUserId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
// Module scope, deliberately: block-scoping this inside the handler is how
// /ai-fill threw ReferenceError after its SSE headers had already gone out
// (routes/notebooks.js:43 records the same lesson).
const { TIER_DEFAULTS } = require('../../core/llm/modelResolver');
const { toCitations } = require('../../core/kb/citation');

/** How many passages to retrieve. Eight is what the artboard's list shows. */
const ASK_TOP_K = 8;
/** A test question is a question, not an essay prompt. */
const MAX_QUESTION_CHARS = 2000;
/** Guard against a source whose passages are enormous. */
const MAX_CHUNK_CHARS = 4000;

const QUESTION_TEXT = 'Type a question to test this knowledge base with.';
const AskBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    question: z.string({ required_error: QUESTION_TEXT, invalid_type_error: QUESTION_TEXT })
        .trim().min(1, QUESTION_TEXT)
        .max(MAX_QUESTION_CHARS, `A test question is at most ${MAX_QUESTION_CHARS} characters.`),
}).strict());

router.post('/:id/ask', requireAuth, validate({ body: AskBody }), async (req, res, next) => {
    let headersSent = false;
    const send = (event, data) => {
        if (!headersSent) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const { question } = req.body;

        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        // The id came off the URL. quickKBSearch will search whatever it is
        // handed, so this is the boundary.
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

        const userId = getUserId(req);

        // ── Retrieve ────────────────────────────────────────────────
        const { quickKBSearch } = require('../../core/agentRuntime/knowledgeSearch');
        let chunks = [];
        try {
            chunks = await quickKBSearch(userId, [kb.id], question, { topK: ASK_TOP_K, session: req.session }) || [];
        } catch (e) {
            log.warn('[KB/ask] search failed:', e.message);
            return res.status(502).json({ error: 'Could not search this knowledge base right now.' });
        }

        // Name the sources so a citation can say "Nextcloud · /Sales" and not
        // only the document's filename. Best-effort: a citation without it is
        // still worth showing.
        let sourcesById = new Map();
        try {
            const rows = await require('../../stores/kbSources').listByKb(kb.id);
            sourcesById = new Map((rows || []).map(s => [s.id, s]));
        } catch (_) { /* no kb_sources on this install */ }

        const citations = toCitations(chunks, { kind: 'kb_chunk' }).map(c => ({
            ...c,
            sourceName: c.sourceName || sourcesById.get(c.sourceId)?.name || null,
        }));

        // Nothing found is an ANSWER to a test question, and a useful one —
        // "the sources do not cover this" is exactly what the person is
        // checking for. No model call, because there is nothing to ground on.
        if (chunks.length === 0) {
            res.writeHead(200, SSE_HEADERS);
            headersSent = true;
            send('kb_sources', { sources: [] });
            send('done', { empty: true, usage: null });
            return res.end();
        }

        // ── Prompt ──────────────────────────────────────────────────
        const { fenceChunks, DATA_NOT_INSTRUCTIONS } = require('../../core/kb/sourceFencing');
        const fenced = fenceChunks(chunks, { maxChars: MAX_CHUNK_CHARS });

        const systemPrompt = `You are answering a question from one knowledge base, so its owner can check whether the right passages are found before an agent uses it.

[RETRIEVED SOURCE PASSAGES]
${DATA_NOT_INSTRUCTIONS}

Answer ONLY from these passages. Cite them as [Source N] where N is the index attribute.
If they do not contain the answer, say so plainly and name what they DO cover — that is
a useful result for someone testing their sources, not a failure to apologise for.

${fenced}`;

        // ── Stream ──────────────────────────────────────────────────
        const { getUserTierMap } = require('../../core/llm/modelResolver');
        const { getProviderForModel } = require('../../core/aiAgent');
        const { getAdapter } = require('../../core/providers');

        const tiers = await getUserTierMap({ userOrgId: kb.organization_id || null, userId });
        // `fast` on purpose: this is a retrieval check, not a reasoning task,
        // and it is run over and over while somebody tunes their sources.
        const tier = tiers.fast || TIER_DEFAULTS.fast || {};
        const modelId = tier.modelId || tier.model;
        const config = await getProviderForModel(modelId);
        const apiUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, apiUrl);

        res.writeHead(200, SSE_HEADERS);
        headersSent = true;
        // The citations go out BEFORE the answer: a person testing their
        // sources needs to see what was found while the answer is still
        // arriving, not after they have read a paragraph built on it.
        send('kb_sources', { sources: citations });

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
        ];

        await adapter.stream(
            config.apiKey, apiUrl, config.modelId || modelId, messages,
            { maxTokens: Math.min(tier.maxTokens || 2048, 2048), temperature: 0.2 },
            (streamType, data) => {
                if (streamType === 'text' && data?.text) send('text', { text: data.text });
                // A `thinking` block is the model's scratchpad, not an answer;
                // showing it here would put reasoning about the passages in the
                // place the answer goes.
                else if (streamType === 'error') send('error', data);
            },
        );
        send('done', {});
        res.end();
    } catch (e) {
        log.error('[KB/ask] error:', e.message);
        if (headersSent) {
            // The headers are out; a 500 is no longer available, so the error
            // has to travel as an event or the client waits for ever.
            send('error', { error: e.message });
            res.end();
        } else {
            next(e);
        }
    }
});

const SSE_HEADERS = Object.freeze({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // nginx buffers a streamed response into uselessness without this.
    'X-Accel-Buffering': 'no',
});

module.exports = router;
