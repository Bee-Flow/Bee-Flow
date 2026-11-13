// @typecheck
/**
 * Image Generation Tool — extracted from directChat.js for shared use
 */

const fs = require('fs');
const path = require('path');
const log = require('../../telemetry/log');
const { mediaUsageFields } = require('./mediaUsage');
const { generateImage, ImageGenerationError } = require('../media/imageGeneration.mts');

const NO_WORKAROUND = 'Do NOT attempt to generate images using code, HTML, Canvas, WebGL, SVG, or any other workaround.';

/** What the model is told to do with each refusal; the user-facing reason follows it. */
const IMAGE_ERROR_LEAD = {
    not_configured: 'Image generation is not available. Tell the user and ask them to contact an administrator.',
    limit_reached: 'The user has reached their image limit. Tell the user exactly this and do not try again:',
    no_image: 'Image generation failed. Tell the user and suggest trying a different prompt.',
    provider_error: 'Image generation failed. Tell the user what went wrong:',
};

const IMAGE_GEN_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'generate_image',
            description: 'Generate an AI image based on a detailed text prompt. Use this when the user asks you to create, generate, draw, or design an image, picture, illustration, or visual. The generated image is displayed inline AND saved to a URL (imageUrl) that you can place on a slide as `image.url` in create_presentation / nextcloud_create_presentation.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'A detailed description of the image to generate. Be specific about style, colors, composition, lighting, and subject.'
                    },
                    aspect_ratio: {
                        type: 'string',
                        description: 'Aspect ratio for the image. Options: 1:1, 16:9, 9:16, 4:3, 3:4. Default: 1:1'
                    }
                },
                required: ['prompt']
            }
        }
    }
];

function isImageGenTool(name) {
    return name === 'generate_image';
}

/**
 * @param {(arg0: string, arg1: { data: string; mimeType: string | null; }) => void} send
 * @param {import('./mediaUsage').MediaCaller | null} [caller] the dispatch context: who and which agent/conversation
 */
async function executeImageGenTool(args, imageGenSettings, send, /** @type {import('express').Request} */ req, caller = null) {
    const prompt = args.prompt;
    const aspectRatio = args.aspect_ratio || imageGenSettings?.aspectRatio || '1:1';

    // One path for every backend (Google, Azure): it checks the user's image
    // limit, generates, and writes the usage row.
    let result;
    try {
        result = await generateImage({
            prompt, aspectRatio, model: imageGenSettings?.model || null,
            who: mediaUsageFields(req, caller),
        });
    } catch (e) {
        if (!(e instanceof ImageGenerationError)) throw e;
        return { error: `${IMAGE_ERROR_LEAD[e.code]} ${e.message} ${NO_WORKAROUND}` };
    }

    // Send image via SSE so it shows inline
    send('image', { data: result.imageBase64, mimeType: result.mimeType });

    // Save image to RustFS (or local disk as fallback)
    /** @type {string | null} */
    let imageUrl = null;
    try {
        const crypto = require('crypto');
        const storageStore = require('../../stores/storageStore');
        const ext = (result.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

        if (storageStore.isAvailable()) {
            const userId = req?.session?.user?.id || 'anonymous';
            const key = storageStore.buildKey(userId, 'images', filename);
            await storageStore.uploadFile(key, Buffer.from(result.imageBase64, 'base64'), result.mimeType || 'image/png');
            imageUrl = storageStore.buildProxyUrl(key);
            log.info(`[ImageGen Tool] Saved to RustFS: ${key}`);
        } else {
            // Fallback: local disk
            const genDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'generated');
            await fs.promises.mkdir(genDir, { recursive: true });
            await fs.promises.writeFile(path.join(genDir, filename), Buffer.from(result.imageBase64, 'base64'));
            imageUrl = `/uploads/generated/${filename}`;
            log.info(`[ImageGen Tool] Saved to disk: ${imageUrl}`);
        }
    } catch (e) {
        log.warn('[ImageGen Tool] Failed to save image to disk:', /** @type {Error} */ (e).message);
    }

    return {
        success: true,
        message: `Image generated and already displayed inline to the user. Do NOT use markdown image syntax or try to embed the image again. Just describe what was created or ask if they want changes.`,
        prompt,
        aspectRatio,
        imageUrl: imageUrl || null,
    };
}

module.exports = { IMAGE_GEN_TOOLS, isImageGenTool, executeImageGenTool };
