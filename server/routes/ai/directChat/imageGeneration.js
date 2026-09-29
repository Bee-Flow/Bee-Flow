/**
 * Direct Chat — one-shot image generation (POST /chat/generate-image).
 *
 * Moved verbatim out of routes/ai/directChat.js when the router was split.
 *
 * The aspect ratio is checked for its SHAPE only ('16:9'), not against a
 * list: Google decides which ratios a model draws, and a list here would
 * refuse one it has since added. What the shape check buys is a 400 naming
 * the field for '16x9' or 'wide', which Google answered with an error that
 * surfaced here as a 500.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const configStore = require('../../../stores/configStore');
const { googleAdapter } = require('../../../core/providers');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { z } = require('zod');

const PROMPT_TEXT = 'Prompt is required';
const RATIO_TEXT = "aspectRatio is width:height, like '1:1' or '16:9'.";

const GenerateImageBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // A prompt that was not text reached `prompt.substring` and was a 500.
    prompt: z.string({ required_error: PROMPT_TEXT, invalid_type_error: PROMPT_TEXT }).trim().min(1, PROMPT_TEXT),
    // '' is "no preference": the square default, as before.
    aspectRatio: z.string({ invalid_type_error: RATIO_TEXT }).trim().regex(/^(\d{1,2}:\d{1,2})?$/, RATIO_TEXT).optional(),
    conversationId: z.string({ invalid_type_error: 'conversationId is the id of the conversation the image belongs to.' }).nullish(),
}).strict());

// ─── Image Generation (Google Nano Banana 2) ──────────────────────

router.post('/chat/generate-image', requireAuth, validate({ body: GenerateImageBody }), async (req, res) => {
    const { prompt, aspectRatio, conversationId } = req.body;
    const userId = req.session.user.id;

    const googleApiKey = await configStore.getSecret('google_api_key');
    if (!googleApiKey) {
        return res.status(400).json({ error: 'Google API key not configured. Add it in Admin → AI Config → API Keys.' });
    }

    log.info(`[ImageGen] Generating image for user ${userId}: "${prompt.substring(0, 80)}"`);

    const result = await googleAdapter.generateImage(googleApiKey, prompt, {
        aspectRatio: aspectRatio || '1:1',
    });

    if (!result.imageBase64) {
        return res.status(500).json({ error: 'No image was generated. Try a different prompt.' });
    }

    // Log usage
    try {
        const usageStore = require('../../../stores/usageStore');
        await usageStore.logUsage({
            agent_id: null,
            agent_name: 'direct-chat',
            model: 'gemini-3.1-flash-image-preview',
            prompt_tokens: prompt.length,
            completion_tokens: 0,
            total_tokens: prompt.length,
            source: 'image_generation',
            conversation_id: conversationId || null,
        });
    } catch (e) {
        log.warn('[ImageGen] Failed to log usage:', e.message);
    }

    res.json({
        imageBase64: result.imageBase64,
        mimeType: result.mimeType,
        text: result.text,
        conversationId: conversationId || null,
    });
});

module.exports = router;
