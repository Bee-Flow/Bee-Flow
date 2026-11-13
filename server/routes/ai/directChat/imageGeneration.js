// @typecheck strict
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
const { requireAuth } = require('../../../auth/permissions');
const { spendLimiter } = require('../../../utils/perUserRateLimit');
const { validate } = require('../../../core/http/validate');
const { z, typeError } = require('../../../utils/zod');
const { sessionUser } = require('../../../core/http/sessionUser');
const { mediaUsageFields } = require('../../../core/tools/mediaUsage');
const { resolveTurnOrgId } = require('./inputShield');
const { generateImageForRoute } = require('../../../core/media/imageHttp');

const PROMPT_TEXT = 'Prompt is required';
const RATIO_TEXT = "aspectRatio is width:height, like '1:1' or '16:9'.";

const GenerateImageBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // A prompt that was not text reached `prompt.substring` and was a 500.
    prompt: z.string({ error: PROMPT_TEXT }).trim().min(1, PROMPT_TEXT),
    // '' is "no preference": the square default, as before.
    aspectRatio: z.string({ error: typeError({ invalid: RATIO_TEXT }) }).trim().regex(/^(\d{1,2}:\d{1,2})?$/, RATIO_TEXT).optional(),
    conversationId: z.string({ error: typeError({ invalid: 'conversationId is the id of the conversation the image belongs to.' }) }).nullish(),
}).strict());

// ─── Image Generation (Google or Azure, core/media/imageGeneration.mts) ──────

// Images per user per minute, each a paid generation. IMAGE_GEN_RPM sets it (0 = no limit).
const imageGenLimiter = spendLimiter({ env: 'IMAGE_GEN_RPM', fallback: 30, name: 'chat-image-gen' });

router.post('/chat/generate-image', requireAuth, imageGenLimiter, validate({ body: GenerateImageBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof GenerateImageBody>, import('qs').ParsedQs>} */ req, res) => {
    const { prompt, aspectRatio, conversationId } = req.body;
    const userId = sessionUser(req).id;

    log.info(`[ImageGen] Generating image for user ${userId}`);

    // One path for every backend (Google, Azure): it checks the user's image
    // limit, generates, and writes the usage row.
    const result = await generateImageForRoute({
        prompt,
        aspectRatio: aspectRatio || '1:1',
        who: mediaUsageFields(req, { userId, orgId: await resolveTurnOrgId(req), conversationId: conversationId || null }),
    });

    res.json({
        imageBase64: result.imageBase64,
        mimeType: result.mimeType,
        text: result.text,
        conversationId: conversationId || null,
    });
});

module.exports = router;
