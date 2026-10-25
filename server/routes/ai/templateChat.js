/** @typedef {import('../../core/providers').BaseProvider} BaseProvider */
/**
 * Template Chat Routes — AI-powered chat for filling Word templates.
 *
 * SSE streaming endpoint that provides context-aware AI chat
 * with template parameters and optional meeting note context.
 * Reuses the same streaming pattern as directChat.js.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * The body is a zod schema, `.strict()`, validated before the stream opens,
 * so a refusal is a JSON 400 and not an `error` event inside a 200. The
 * templates page posts through the shared chat composer (useChatEngine's
 * direct mode), which sends its whole payload to every direct endpoint; the
 * keys this route has no use for — image and media settings, web search,
 * memory, project, skills, reasoning effort — are accepted and ignored, and
 * listed by name so a misspelling of one this route DOES read is still a 400.
 *
 * What the hand-rolled reads let through, each under a 200:
 *
 *   - `meetingNoteIds` past the fifth were dropped: the picker has no limit,
 *     said "7 selected — meeting notes are loaded as context", and the model
 *     filled the template from five. Every selected note is loaded now, the
 *     same 20,000-character budget shared between them (up to 20 notes);
 *   - `meetingNoteIds` as a single id instead of a list loaded no note at
 *     all, and a history that was not a list was dropped;
 *   - a history message whose content was not text ended the turn with the
 *     internal TypeError as its error text.
 *
 * NOT closed here: a `timezone` Node does not know. The composer sends the
 * browser's own zone, and where the browser cannot tell, ICU answers
 * `Etc/Unknown` — refusing that would shut the template chat for exactly
 * the people the direct chat beside it still serves. The clock falls back to
 * the default zone for it (core/llm/clock.formatLocalNow), as it does there.
 * Nor an unknown `modelTier`: which tiers exist is configuration (custom org
 * tiers included), and the resolver answers one it cannot find with fast.
 *
 * `conversationId` only scopes the privacy-shield token map of this turn.
 * That map is keyed by conversation id alone, so a caller who sent SOMEONE
 * ELSE's conversation id read that conversation's tokens back as real values
 * in its own stream, and merged its own into theirs. The scope is namespaced
 * by user now. (The templates page never sends one.)
 */

const express = require('express');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const {
    buildTemplateContext, buildInstructionsContext, formatMeetingNote, buildMeetingContext,
    buildKbContext, buildSystemPrompt, buildHistoryMessages,
} = require('./templateChatPrompt');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
const { validate } = require('../../core/http/validate');

/** The meeting-note context budget: five notes at 4,000 characters, shared. */
const MEETING_CONTEXT_CHARS = 20_000;
const MEETING_NOTE_CHARS = 4000;
const MAX_MEETING_NOTES = 20;

const NOTES_TEXT = `meetingNoteIds is a list of up to ${MAX_MEETING_NOTES} meeting note ids.`;
const HISTORY_TEXT = 'history is a list of { role: user | assistant, content } messages.';
const ATTACHMENT_TEXT = 'Each attachment is { name, type, content }.';
const TZ_TEXT = 'timezone is a zone name, like Europe/Amsterdam.';
const TemplateTurnBody = z.object({
    message: worded('Message required').min(1, 'Message required'),
    templateId: worded('Template ID required').min(1, 'Template ID required').max(200, 'Template ID required'),
    conversationId: z.string({ error: typeError({ invalid: 'conversationId must be text.' }) }).max(200).nullish(),
    history: z.array(z.object({
        role: z.enum(['user', 'assistant'], { error: () => HISTORY_TEXT }),
        content: worded(HISTORY_TEXT),
        attachments: z.array(z.unknown()).optional(),   // history carries them; this route reads text only
    }, { error: typeError({ invalid: HISTORY_TEXT }) }).strict(), { error: typeError({ invalid: HISTORY_TEXT }) }).max(500, HISTORY_TEXT).optional(),
    meetingNoteIds: z.array(worded(NOTES_TEXT).min(1, NOTES_TEXT).max(200, NOTES_TEXT), { error: typeError({ invalid: NOTES_TEXT }) })
        .max(MAX_MEETING_NOTES, NOTES_TEXT).optional(),
    modelTier: z.string({ error: typeError({ invalid: 'modelTier is the name of a model tier.' }) }).max(100).optional(),
    // Text, but not checked against the zone list: see the header.
    timezone: z.string({ error: typeError({ invalid: TZ_TEXT }) }).max(64, TZ_TEXT).optional(),
    // The composer's own shape; image, Drive-export, PDF, Word or text.
    attachments: z.array(z.object({
        name: z.string({ error: typeError({ invalid: ATTACHMENT_TEXT }) }).max(500).nullish(),
        type: z.string({ error: typeError({ invalid: ATTACHMENT_TEXT }) }).max(200).nullish(),
        content: z.string({ error: typeError({ invalid: ATTACHMENT_TEXT }) }).nullish(),
        source: z.string({ error: typeError({ invalid: ATTACHMENT_TEXT }) }).max(100).nullish(),
    }, { error: typeError({ invalid: ATTACHMENT_TEXT }) }).passthrough(), { error: typeError({ invalid: ATTACHMENT_TEXT }) }).max(50, 'At most 50 attachments per message.').optional(),
    // Sent by the shared composer to every direct endpoint; not used here.
    imageGenSettings: z.unknown().optional(),
    nanoBananaSettings: z.unknown().optional(),
    disabledMedia: z.unknown().optional(),
    webSearchEnabled: z.unknown().optional(),
    memoryWriteEnabled: z.unknown().optional(),
    memoryReadEnabled: z.unknown().optional(),
    projectId: z.unknown().optional(),
    activeSkillIds: z.unknown().optional(),
    reasoningEffort: z.unknown().optional(),
}).strict();

const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const templateStore = require('../../stores/templateStore');
const { resolveTurnTier } = require('../../core/llm/resolveTurnModel');
const { openSse } = require('../../core/http/sseHelpers');
const transcriptionStore = require('../../stores/transcriptionStore');
require('../../core/serviceAuth');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { fallback } = require('../../utils/bestEffort');

// ─── Streaming Template Chat ─────────────────────────────────────

router.post('/chat/template/stream', requireAuth, validate({ body: TemplateTurnBody }), async (req, res) => {
    const { message, templateId, conversationId, history, meetingNoteIds, modelTier, timezone, attachments } = req.body;
    const userId = req.session.user.id;

    // Load template
    const template = await templateStore.getTemplate(templateId, userId);
    if (!template) {
        return res.status(404).json({ error: 'Template not found' });
    }

    // ── Subscription limit enforcement (mirrors /api/agents/:id/chat/stream) ──
    {
        const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
        const { resolveUserOrgIds: _resolveOrgs } = require('../../auth');
        const orgIds = await _resolveOrgs(req);
        const limitOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
        if (limitError) return res.status(402).json({ error: limitError });
    }

    // Resolve user's org for EU-mode tier overrides — cached tier-org (M2),
    // collapses the per-message getAllGroups scan to one lookup per user/~45s.
    const { resolveModelForTier, getTierConfig, resolveEffectiveOrgId } = require('../../core/llm/modelResolver');
    const userOrgId = await resolveEffectiveOrgId(req, { userId });

    // Resolve model from tier config (EU-aware). Which tier:
    // core/llm/resolveTurnModel — `standard` is read as `fast`, `auto` is left
    // to the resolver (which answers it with fast), and a tier the person's
    // groups do not allow is refused.
    const turnTier = await resolveTurnTier({
        modelTier, message, tiers: null, userId, userOrgId,
        surface: 'TemplateChat', standardIsFast: true, classifyAuto: false,
    });
    if (turnTier.refusal) return res.status(turnTier.refusal.status).json({ error: turnTier.refusal.error, code: turnTier.refusal.code });
    const resolvedTier = turnTier.tier;
    const tierConfig = await getTierConfig(resolvedTier, { userOrgId, userId });
    let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model || 'mistral-small-latest';
    }

    if (userOrgId) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
        if (shield?.euModeEnabled) {
            log.info(`[TemplateChat] EU mode active for org ${userOrgId}`);
        }
    }

    // Resolve provider
    /** @type {BaseProvider} */
    /** @type {BaseProvider} */
    /** @type {BaseProvider} */
    /** @type {BaseProvider} */
    /** @type {BaseProvider} */
    let config, adapter;

    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        log.error(`[TemplateChat] Provider resolution failed for model "${modelId}":`, /** @type {Error} */ (providerErr).message);
        throw new HttpError(400, 'provider_unavailable', 'No AI provider is available for this model. Ask an administrator to check the model configuration.');
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    log.info(`[TemplateChat] Model: ${modelId} (tier: ${resolvedTier}) for template: ${template.name}`);

    // SSE headers, the client's stop (the composer's stop button aborts the
    // browser fetch; without it the turn ran on, tool rounds and all, and on a
    // single-slot local model the next message queued behind an answer nobody
    // wanted) and the keep-alive that stops the Nextcloud AppAPI proxy from
    // idle-timing a long, silent turn out to a 504 (BFSF-221).
    const { send, signal: clientSignal, isGone } = openSse(res, { heartbeat: true, tag: 'TemplateChat' });

    try {
        const templateContext = buildTemplateContext(template);







        // Inject custom instructions if set
        const instructionsContext = buildInstructionsContext(template);

        // Load meeting notes if requested.
        // Transcripts are user-generated audio content — frame them as untrusted DATA
        // inside sentinel tags so any "instructions" inside the recording can't redirect the model.
        let meetingContext = '';
        if (meetingNoteIds && meetingNoteIds.length > 0) {
            /** @type {string[]} */
            const noteTexts = [];
            // Every note the user picked, the budget shared between them —
            // 4K each up to five, less each beyond (the schema caps the list).
            const perNote = Math.min(MEETING_NOTE_CHARS, Math.floor(MEETING_CONTEXT_CHARS / meetingNoteIds.length));
            for (const noteId of meetingNoteIds) {
                try {
                    const note = await transcriptionStore.getTranscription(noteId, userId);
                    if (note) {
                        noteTexts.push(formatMeetingNote(note, perNote));
                    }
                } catch (err) {
                    log.warn(`[TemplateChat] Failed to load meeting note ${noteId}:`, /** @type {Error} */ (err).message);
                }
            }
            if (noteTexts.length > 0) {
                meetingContext = buildMeetingContext(noteTexts);
            }
        }

        // Search template knowledge bases if any
        let kbContext = '';
        const kbIds = template.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            try {
                const { quickKBSearch } = require('../../core/agentRuntime/knowledgeSearch');
                const kbResults = await quickKBSearch(userId, kbIds, message, { topK: 6, session: req.session });

                if (kbResults.length > 0) {
                    // Injected without a tool call, so the Privacy Shield's
                    // "own server" block list is applied here (BFSF-354).
                    const { resolveShieldFor } = require('../../core/privacy/orgShield');
                    const kbShield = await resolveShieldFor({ orgId: userOrgId, userId }).catch((e) => fallback('routes/ai/templateChat:anon', e, null));
                    // The "### Source N:" label goes through the same scan.
                    const { injectedPassagesPrompt } = require('../../core/privacy/toolPiiGate');
                    const kbText = await injectedPassagesPrompt(kbResults, { shield: kbShield, tag: 'TemplateChat' });
                    kbContext = buildKbContext(kbText);
                    log.info(`[TemplateChat] Injected ${kbResults.length} KB chunks for template "${template.name}"`);
                }
            } catch (kbErr) {
                log.warn('[TemplateChat] KB search failed:', /** @type {Error} */ (kbErr).message);
            }
        }

        // Build system prompt
        const systemPrompt = buildSystemPrompt({ templateContext, instructionsContext, kbContext, meetingContext, timezone });

        let messages = [{ role: 'system', content: systemPrompt }];

        // ── Privacy Shield for attachments + response restore ──────────────
        // Template chat had NO PII pipeline. Mirror directChat: scan extracted
        // attachment text (tokenize PII / block per org policy) before it enters
        // the prompt, then restore tokens on the streamed reply so the user sees
        // real values. Conv-scoped so the scan's mergeTokenMap + the response
        // un-tokeniser share one map; a synthetic id covers ephemeral sessions.
        // A caller's own id is namespaced by user: the map is keyed by id
        // alone, and another user's conversation id must not open theirs.
        const _crypto = require('crypto');
        const _dlpConvId = conversationId ? `tmpl-${userId}-${conversationId}` : `tmpl-${_crypto.randomUUID()}`;
        const { resolveShieldFor: _resolveShieldFor } = require('../../core/privacy/orgShield');
        const _psShield = await _resolveShieldFor({ orgId: userOrgId, userId }).catch((e) => fallback('routes/ai/templateChat:anon#2', e, null));
        const { scanAttachmentText: _scanAttText } = require('../../core/dlp/attachmentScanner');
        const _dlpActive = !!_psShield?.enabled;
        /**
         * @param {string} text
         * @param {string} filename
         */
        const _scanExtracted = async (text, filename) => {
            if (!_dlpActive || !text) return text;
            const r = await _scanAttText({ text, filename, orgShield: _psShield, conversationId: _dlpConvId });
            if (r.action === 'block') { const e = new Error('attachment blocked'); e.code = 'ATTACHMENT_PII_BLOCKED'; e.filename = filename; e.summary = r.summary; throw e; }
            // Prefer whatever the scanner returned: on an incomplete scan that is
            // the TRUNCATED document, and falling back to `text` would put the
            // unchecked tail straight back into the prompt.
            return typeof r.text === 'string' ? r.text : text;
        };

        // Add conversation history (filter out empty messages)
        messages.push(...buildHistoryMessages(history));

        // Add current message (with attachments if any)
        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });

            try {
                for (const att of attachments) {
                    try {
                        if (att.type && att.type.startsWith('image/') && att.content) {
                            // Image — pass as multimodal content (image PII not scanned; deferred)
                            contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                        } else if (att.source === 'google-drive' && att.content) {
                            // Google Drive file — already exported as text
                            const safe = await _scanExtracted(att.content, att.name);
                            contentParts.push({ type: 'text', text: `--- Google Drive: ${att.name} ---\n${safe}\n--- End of ${att.name} ---` });
                        } else if (att.content && att.type && att.type.includes('pdf')) {
                            // PDF — extract text
                            const base64Data = att.content.split(',')[1] || att.content;
                            const pdfBuffer = Buffer.from(base64Data, 'base64');
                            let pdfText = '';
                            try {
                                const { extractTextFromPDF } = require('../../core/documents/pdfExtractor');
                                pdfText = await extractTextFromPDF(pdfBuffer, att.name);
                            } catch (e) {
                                log.warn(`[TemplateChat] PDF extraction failed for ${att.name}:`, /** @type {Error} */ (e).message);
                            }
                            if (pdfText) {
                                const safe = await _scanExtracted(pdfText, att.name);
                                contentParts.push({ type: 'text', text: `[PDF Document: ${att.name}]\n---\n${safe}\n---` });
                            }
                        } else if (att.content && att.type && (att.type.includes('wordprocessing') || att.name?.endsWith('.docx'))) {
                            // Word doc — extract text with mammoth
                            const base64Data = att.content.split(',')[1] || att.content;
                            const docBuffer = Buffer.from(base64Data, 'base64');
                            try {
                                const mammothLib = require('mammoth');
                                const result = await mammothLib.extractRawText({ buffer: docBuffer });
                                if (result.value) {
                                    const safe = await _scanExtracted(result.value, att.name);
                                    contentParts.push({ type: 'text', text: `[Word Document: ${att.name}]\n---\n${safe}\n---` });
                                }
                            } catch (e) {
                                if (e?.code === 'ATTACHMENT_PII_BLOCKED') throw e;
                                log.warn(`[TemplateChat] Word extraction failed for ${att.name}:`, /** @type {Error} */ (e).message);
                            }
                        } else if (att.content && typeof att.content === 'string') {
                            // Plain text or other text-based files
                            const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                            if (textContent) {
                                const safe = await _scanExtracted(textContent.slice(0, 8000), att.name);
                                contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${safe}\n---` });
                            }
                        }
                    } catch (e) {
                        if (e?.code === 'ATTACHMENT_PII_BLOCKED') throw e;
                        log.warn(`[TemplateChat] Attachment processing failed for ${att.name}:`, /** @type {Error} */ (e).message);
                    }
                }
            } catch (e) {
                if (e?.code === 'ATTACHMENT_PII_BLOCKED') {
                    const cats = Object.keys(e.summary?.byCategory || {}).join(', ');
                    send('error', { error: `Attachment "${e.filename}" was blocked by your organization's Privacy Shield${cats ? ` (contains ${cats})` : ''}.` });
                    return res.end();
                }
                throw e;
            }

            // If we have images, send as multimodal; otherwise combine text parts
            const hasImages = contentParts.some(p => p.type === 'image_url');
            if (hasImages) {
                messages.push({ role: 'user', content: contentParts });
            } else {
                const combinedText = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
                if (combinedText.trim()) messages.push({ role: 'user', content: combinedText });
            }
        } else {
            messages.push({ role: 'user', content: message });
        }

        // PII token-preservation: when attachment scanning minted tokens, tell the
        // model what the [token]s mean so it echoes them verbatim instead of
        // meta-commenting on "anonymised" values. Best-effort.
        if (_dlpActive) {
            try {
                const { buildTokenPreservationAddendum } = require('../../core/dlp/tokenPreservationPrompt');
                const _convMap = require('../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId);
                const _add = buildTokenPreservationAddendum(_convMap);
                if (_add && messages[0]?.role === 'system') messages[0].content += _add;
            } catch (err) { fallback('routes/ai/templateChat:anon#3', err); /* best-effort */ }
        }

        // Stream response
        const tierSettings = tierConfig || {};
        const { TIER_DEFAULTS } = require('../../core/llm/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            // Carries the client's stop all the way to the model request.
            signal: clientSignal,
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        };

        // Response un-tokeniser: restore [token]s minted from attachment PII back
        // to real values as chunks stream, so the user never sees placeholders.
        // Passthrough when the shield is off (zero behavior change).
        const _streamUntok = _dlpActive
            ? require('../../core/dlp/untokeniseStream').createUntokeniser(() => require('../../core/dlp/dlpRunner').getConversationTokenMap(_dlpConvId))
            : null;

        const streamCallback = (type, data) => {
            if (type === 'text') {
                const safe = _streamUntok ? _streamUntok.push(data.text) : data.text;
                if (safe) send('content', { text: safe });
            } else if (type === 'thinking') {
                send('thinking', { text: data.text });
            } else if (type === 'error') {
                send('error', data);
            }
            // 'done' handled after stream completes
        };

        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);

        if (_streamUntok) {
            const _tail = _streamUntok.flush();
            if (_tail) send('content', { text: _tail });
        }

        send('done', {});
        res.end();

    } catch (err) {
        // The user pressed stop: the socket is already gone, and a cancelled
        // answer is not an error to report.
        if (isGone() || /** @type {Error} */ (err)?.name === 'AbortError' || clientSignal.aborted) {
            log.info('[TemplateChat] turn cancelled by the client');
            try { if (!res.writableEnded) res.end(); } catch (err) { log.debug('socket already gone', err); }
            return;
        }
        log.error('[TemplateChat] Error:', err);
        send('error', { error: `Chat error: ${/** @type {Error} */ (err).message}` });
        res.end();
    }
});

// ── Get available meeting notes for template context ──────────────

router.get('/chat/template/meeting-notes', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const notes = await transcriptionStore.getTranscriptions(userId, { limit: 50 });
    res.json({
        notes: notes.map(n => ({
            id: n.id,
            title: n.title,
            createdAt: n.createdAt,
            durationSeconds: n.durationSeconds,
            speakerCount: n.speakerCount,
        }))
    });
});

module.exports = router;
