// @typecheck
/**
 * Notebook Studio routes, mounted by routes/notebooks.js at the same place in
 * its route table.
 *
 * Endpoints:
 *   POST   /:id/generate/:type  — generate content from the sources (SSE)
 *   POST   /:id/ai-fill         — fill the document's {{parameters}} (SSE)
 *
 * Moved here unchanged from routes/notebooks.js. Both need an editor
 * (routes/notebooksAccess.js) and go through the Privacy Shield on the
 * notebook chat's path (agents/notebooks/notebookAiShield.js).
 */

const express = require('express');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const router = express.Router();

const notebookStore = require('../stores/notebookStore');

/**
 * Request after requireNotebookRole: the loaded notebook and the caller's role on it.
 * @typedef {import('express').Request<{ id: string, sid: string, type: string }> & { notebook: NonNullable<Awaited<ReturnType<typeof notebookStore.getNotebook>>>, notebookRole: string }} NotebookReq
 */
// Module scope on purpose: /ai-fill reads TIER_DEFAULTS too, and when this was
// require()'d inside the /generate/:type handler it was block-scoped there, so
// every AI-Fill run threw ReferenceError after the SSE headers had been sent.
const { TIER_DEFAULTS } = require('../core/llm/modelResolver');
const { validate } = require('../core/http/validate');
const { openSse } = require('../core/http/sseHelpers');
const { worded, bodyOf } = require('../core/http/schemaParts');
const { partitionNotebookKbIds } = require('../agents/notebooks/notebookKbAccess');
/** @typedef {import('../agents/notebooks/notebookAiShield').ShieldRefusal} ShieldRefusal */
const { shieldNotebookPrompt } = require('../agents/notebooks/notebookAiShield');
const { asEditor, text } = require('./notebooksShared');
// requireAuth is the canonical gate from auth/permissions (see routes/notebooks.js).
const { requireAuth } = require('../auth/permissions');
const { sessionUser } = require('../core/http/sessionUser');

// ── What a caller may send ─────────────────────────────────────────
// Closed bodies (see routes/notebooksShared.js).
const modelTier = text('modelTier is the name of a model tier.', 100).optional();
const GenerateBody = bodyOf({ modelTier }, 'Generating');
const AiFillBody = bodyOf({
    documentContent: worded('No document content provided'),
    modelTier,
}, 'AI fill');

// ── Studio: Generate Content (FAQ / Summary / Study Guide) ──────

// Studio generation types. The study-aid / podcast gimmicks were removed
// so older clients calling those types fail loud instead of wasting an LLM
// round-trip for a result nothing renders nicely anymore.
const VALID_GEN_TYPES = new Set([
    'summary', 'briefing_doc', 'blog_post', 'faq',
    'mind_map', 'data_table',
]);
const REMOVED_GEN_TYPES = new Set(['studyGuide', 'flashcards', 'quiz', 'audio_overview']);

router.post('/:id/generate/:type', requireAuth, validate({ body: GenerateBody }), asEditor, /** @param {NotebookReq} req */ async (req, res) => {
    try {
        const userId = sessionUser(req).id;
        const notebookId = req.params.id;
        const type = req.params.type;
        const { modelTier } = req.body;

        if (REMOVED_GEN_TYPES.has(type)) {
            return res.status(400).json({
                error: `Generation type "${type}" was removed. Use Executive Summary, Briefing Doc, FAQ, Mind Map, or Data Table instead.`,
                code: 'generation_type_removed',
            });
        }

        const nb = req.notebook;

        if (!VALID_GEN_TYPES.has(type)) {
            return res.status(400).json({ error: `Unknown generation type "${type}"`, code: 'generation_type_unknown' });
        }

        const sources = await notebookStore.getSources(notebookId);
        const readySources = sources.filter((/** @type {{ status: string }} */ s) => s.status === 'ready');
        // A doc-only notebook is still generatable — gatherNotebookContent
        // folds the document body in below.
        const hasDoc = !!(nb.documentMd || nb.documentContent || '').trim();
        if (readySources.length === 0 && !hasDoc) {
            return res.status(400).json({ error: 'Add a source or write something in the document first' });
        }

        // Gather source content using shared KB search utility
        const { gatherNotebookContent } = require('../core/kb/notebookKnowledgeSearch');
        // Re-authorize at read time — see the PUT handler. Rows written before
        // kb ids were validated may still carry an inaccessible id, and the
        // gather path does no tenant filtering of its own. The notebook's own
        // base is read by notebook role, so a project member generates from
        // the same sources as its owner.
        const { allowed: kbIds, denied: _deniedKbIds } = await partitionNotebookKbIds(req, nb);
        if (_deniedKbIds.length > 0) {
            log.warn('[Notebooks] dropped inaccessible kb ids on generate:', { notebookId, userId, denied: _deniedKbIds });
        }

        const { content: allContent } = await gatherNotebookContent({
            // The tenant the notebook's chunks are stored under: its owner's.
            userId: nb.userId,
            kbIds,
            sources: readySources,
            documentContent: nb.documentContent,
            options: { maxChars: 50000, topK: 25, minScore: 0.15 },
        });

        if (!allContent.trim()) {
            return res.status(400).json({ error: 'Could not retrieve source content from knowledge base' });
        }

        // Resolve user's org for EU-mode tier overrides — cached tier-org (M2),
        // organizationId-only (no group fallback) to preserve the original shape.
        const { resolveEffectiveOrgId } = require('../core/llm/modelResolver');
        const userOrgId = await resolveEffectiveOrgId(req, { userId, skipGroupFallback: true });
        // The Privacy Shield, on the notebook chat's path (agents/notebooks/notebookAiShield.js).
        const shield = await shieldNotebookPrompt({ orgId: userOrgId, userId, notebookId, sourceText: allContent.slice(0, 50000) });
        if (!shield.ok) return res.status(/** @type {ShieldRefusal} */ (shield).status).json({ error: /** @type {ShieldRefusal} */ (shield).error, code: /** @type {ShieldRefusal} */ (shield).code });

        // Type-specific prompts. Only the types in VALID_GEN_TYPES reach here —
        // the check above rejects everything else.
        /** @type {Record<string, string>} */
        const typePrompts = {
            faq: `Generate a focused FAQ (Frequently Asked Questions) document based on the source material below.
Format as a well-structured markdown document with clear Q&A pairs grouped by topic. Keep answers concise (2-3 sentences each).`,
            summary: `Generate an executive summary based on the source material below. Include Key Findings and Conclusions.`,
            briefing_doc: `Generate a Briefing Document based on the source material below. Include an Executive Summary, Key Analysis, and Recommendations. Write concisely — prioritize substance over volume.`,
            blog_post: `Draft an engaging, well-written Blog Post based on the core themes of the source material. Use a catchy title, headings, and an accessible tone.`,
            mind_map: `Extract the core concepts from the source material and generate a Mermaid.js mind map visualization.
Wrap your output in \`\`\`mermaid ... \`\`\` tags. Focus on hierarchical relationships between the main topics.`,
            data_table: `Extract the most important quantitative data, comparisons, or structured information from the source material and present it as a Markdown table.`,
        };

        const prompt = typePrompts[type] || typePrompts.summary;

        // Resolve model
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const { resolveModelForTier, getEUAwareTiers } = require('../core/llm/modelResolver');
        const { getAdapter } = require('../core/providers');

        let resolvedTier = modelTier || 'balanced';

        // Auto mode: classify using the generation type as a pseudo-message
        if (resolvedTier === 'auto') {
            try {
                const tiers = await getEUAwareTiers({ userOrgId, userId });
                const { classifyWithLLM } = require('../core/llm/promptClassifier');
                const pseudoMessage = `Generate a comprehensive ${type.replace(/([A-Z])/g, ' $1').toLowerCase()} from my notebook sources`;
                const result = await classifyWithLLM(pseudoMessage, tiers, { userOrgId, userId });
                resolvedTier = result.tier;
                log.info(`[Notebooks] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason}) for ${type}`);
            } catch (err) {
                log.info(`[Notebooks] Auto classification failed: ${/** @type {Error} */ (err).message}, using balanced`);
                resolvedTier = 'balanced';
            }
        }

        let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });
        if (!modelId) {
            const config = await getAIConfig();
            modelId = config.model;
            if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
        }
        const config = await getProviderForModel(modelId);
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, apiUrl);

        const { send } = openSse(res);

        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const systemPrompt = `You are an expert content generator. Today is ${today}.

${prompt}

CRITICAL RULES:
- You MUST generate content ONLY based on the source material provided below.
- Do NOT use your own knowledge or training data — ONLY use the information in [SOURCE MATERIAL].
- If the source material doesn't contain enough information, generate what you can from it and note any gaps.
- All questions, answers, facts and claims must be directly traceable to the source text below.
- Cite sources using [Source Name] notation when referencing specific information.

MERMAID DIAGRAMS:
- When it adds value (e.g. architecture overviews, process flows, timelines, relationships), include Mermaid.js diagrams using fenced code blocks:
  \`\`\`mermaid
  graph TD
      A[Start] --> B{Decision}
  \`\`\`
- Use diagram types like: graph/flowchart, sequenceDiagram, mindmap, gantt, pie, classDiagram, stateDiagram, erDiagram, timeline.
- Keep diagrams clean and focused — avoid excessive nodes or overly complex layouts.
- Always place diagrams in their own paragraph, not inline with text.

FORMATTING & SPACING:
- Write in a compact, professional style. Avoid filler phrases and redundant introductions.
- NEVER insert double blank lines between sections. Use a single blank line between headings and paragraphs.
- Keep paragraphs concise: 2-4 sentences max. Prefer short, direct sentences.
- Use bullet points and tables where they convey information more efficiently than paragraphs.
- Do NOT add excessive whitespace, padding paragraphs, or "fluff" content.
- Start sections directly with substantive content — skip generic opening sentences like "In this section we will..."
- The output will be rendered on paginated A4/Letter pages, so space-efficient writing is critical.

[SOURCE MATERIAL]
${shield.units[0]}${shield.addendum}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Generate the ${type} now. Be thorough but concise — prioritize substance over volume. Use compact formatting with minimal whitespace. Where appropriate, include Mermaid diagrams to visualize key concepts, processes, or relationships.` }
        ];

        const _tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: _tierDefaults.maxTokens,
            temperature: 0.4,
        };


        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (streamType, data) => {
            if (streamType === 'text') {
                // Real values back in for the person who asked; the model saw tokens.
                send('content', { text: shield.untokenise.push(/** @type {string} */ (data.text)) });
            } else if (streamType === 'thinking') {
                send('thinking', { text: data.text });
            } else if (streamType === 'error') {
                send('error', data);
            }
        });
        const generatedTail = shield.untokenise.flush();
        if (generatedTail) send('content', { text: generatedTail });

        // (Removed audio_overview ElevenLabs post-processing — the Audio Podcast
        // generation type was retired. Any cached/legacy callers now hit the
        // REMOVED_GEN_TYPES 400 at the top of this route.)

        send('done', {});
        res.end();

    } catch (err) {
        log.error(`[Notebooks] Generate ${req.params.type} failed:`, err);
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: /** @type {Error} */ (err).message })}\n\n`);
            res.end();
        } catch { throw new HttpError(500, 'generation_failed', 'Generation failed'); }
    }
});


// ── AI Fill Parameters ────────────────────────────────────────────
// Extracts {{parameter}} placeholders from the document and fills them
// using the notebook's attached sources.
router.post('/:id/ai-fill', requireAuth, validate({ body: AiFillBody }), asEditor, /** @param {NotebookReq} req */ async (req, res) => {
    try {
        const userId = sessionUser(req).id;
        const nb = req.notebook;

        const { documentContent, modelTier } = req.body;
        if (!documentContent?.trim()) return res.status(400).json({ error: 'No document content provided' });

        // Extract all {{parameter}} placeholders
        const paramRegex = /\{\{([^}]+)\}\}/g;
        /** @type {string[]} */
        const params = [];
        /** @type {RegExpExecArray | null} */
        let match;
        while ((match = paramRegex.exec(documentContent)) !== null) {
            params.push(match[1].trim());
        }
        if (params.length === 0) return res.status(400).json({ error: 'No {{parameters}} found in the document' });

        // Gather source content from KB, the way /generate does it
        // (core/kb/notebookKnowledgeSearch): the notebook owner's tenant, the
        // configured search service and its service credentials. Authorised
        // like chat and generation: the notebook's own base by notebook role,
        // anything else by the caller's own KB access.
        const { allowed: kbIds } = await partitionNotebookKbIds(req, nb);
        const readySources = (await notebookStore.getSources(nb.id)).filter((/** @type {{ status: string }} */ src) => src.status === 'ready');
        const { gatherNotebookContent } = require('../core/kb/notebookKnowledgeSearch');
        const { content: sourceContent } = await gatherNotebookContent({
            userId: nb.userId, kbIds, sources: readySources, documentContent: null,
            options: { maxChars: 60000, topK: 30, minScore: 0.15 },
        });

        if (!sourceContent.trim()) {
            return res.status(400).json({ error: 'No source content available to fill parameters' });
        }

        // Resolve model
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const { resolveModelForTier, getEUAwareTiers, resolveEffectiveOrgId } = require('../core/llm/modelResolver');
        const { getAdapter } = require('../core/providers');

        // Resolve user's org for EU-mode tier overrides — cached tier-org (M2),
        // organizationId-only (no group fallback) to preserve the original shape.
        const userOrgId = await resolveEffectiveOrgId(req, { userId, skipGroupFallback: true });
        // The Privacy Shield over the sources AND the template the person sent.
        const shield = await shieldNotebookPrompt({
            orgId: userOrgId, userId, notebookId: nb.id, sourceText: sourceContent.slice(0, 60000), otherUnits: [documentContent],
        });
        if (!shield.ok) return res.status(/** @type {ShieldRefusal} */ (shield).status).json({ error: /** @type {ShieldRefusal} */ (shield).error, code: /** @type {ShieldRefusal} */ (shield).code });
        const [shieldedSources, shieldedDocument] = shield.units;

        let resolvedTier = modelTier || 'balanced';
        if (resolvedTier === 'auto') {
            try {
                const tiers = await getEUAwareTiers({ userOrgId, userId });
                const { classifyWithLLM } = require('../core/llm/promptClassifier');
                const result = await classifyWithLLM('Fill in template parameters in a document using source information', tiers, { userOrgId, userId });
                resolvedTier = result.tier;
            } catch { resolvedTier = 'balanced'; }
        }

        let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });
        if (!modelId) {
            const config = await getAIConfig();
            modelId = config.model;
            if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
        }
        const config = await getProviderForModel(modelId);
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, apiUrl);

        const { send } = openSse(res);

        const uniqueParams = [...new Set(params)];
        log.info(`[Notebooks] AI Fill: ${uniqueParams.length} unique parameters found for notebook ${nb.id}`);

        const systemPrompt = `You are a document template filling assistant. Your task is to fill in template parameters in a document using ONLY the provided source material.

The document contains {{parameter_name: description}} placeholders. You must:
1. Read the source material carefully
2. Find the correct value for each parameter from the sources
3. Return the COMPLETE document with ALL {{parameters}} replaced by the correct values
4. Keep ALL other text, HTML formatting, and structure EXACTLY as-is
5. If you cannot find the value for a parameter in the sources, replace it with [UNKNOWN: parameter description]
6. Do NOT add, remove, or change any text outside of the {{parameter}} placeholders

PARAMETERS TO FILL:
${uniqueParams.map((p, i) => `${i + 1}. {{${p}}}`).join('\n')}

SOURCE MATERIAL:
${shieldedSources}${shield.addendum}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Here is the document. Replace ALL {{parameter}} placeholders with values from the sources. Return the complete document:\n\n${shieldedDocument}` },
        ];

        const _fillDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = { maxTokens: _fillDefaults.maxTokens, temperature: 0.1 };

        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (streamType, data) => {
            if (streamType === 'text') {
                send('content', { text: shield.untokenise.push(/** @type {string} */ (data.text)) });
            } else if (streamType === 'error') {
                send('error', data);
            }
        });
        const filledTail = shield.untokenise.flush();
        if (filledTail) send('content', { text: filledTail });

        send('done', { params: uniqueParams.length });
        res.end();
    } catch (err) {
        log.error('[Notebooks] AI Fill failed:', err);
        if (!res.headersSent) {
            throw new HttpError(500, 'ai_fill_failed', 'AI Fill failed');
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: /** @type {Error} */ (err).message })}\n\n`);
            res.end();
        }
    }
});

module.exports = router;
