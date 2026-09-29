/**
 * Image Generation Tool — extracted from directChat.js for shared use
 */

const fs = require('fs');
const path = require('path');
const configStore = require('../../stores/configStore');
const { googleAdapter } = require('../providers');
const log = require('../../telemetry/log');

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

async function executeImageGenTool(args, imageGenSettings, send, req) {
    const googleApiKey = await configStore.getSecret('google_api_key');
    if (!googleApiKey) {
        return { error: 'Image generation is not available — the API key is not configured. Tell the user that image generation is currently unavailable and ask them to contact an administrator. Do NOT attempt to generate images using code, HTML, Canvas, WebGL, SVG, or any other workaround.' };
    }

    const prompt = args.prompt;
    const aspectRatio = args.aspect_ratio || imageGenSettings?.aspectRatio || '1:1';

    log.info(`[ImageGen Tool] Generating: "${prompt.substring(0, 80)}" (${aspectRatio})`);

    const result = await googleAdapter.generateImage(googleApiKey, prompt, {
        aspectRatio,
        model: imageGenSettings?.model || 'gemini-3.1-flash-image-preview',
    });

    if (!result.imageBase64) {
        return { error: 'Image generation failed — no image was produced. Tell the user and suggest trying a different prompt. Do NOT attempt to generate images using code, HTML, Canvas, WebGL, SVG, or any other workaround.' };
    }

    // Send image via SSE so it shows inline
    send('image', { data: result.imageBase64, mimeType: result.mimeType });

    // Save image to RustFS (or local disk as fallback)
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
        log.warn('[ImageGen Tool] Failed to save image to disk:', e.message);
    }

    // Log usage
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            agent_id: null,
            agent_name: 'direct-chat',
            model: imageGenSettings?.model || 'gemini-3.1-flash-image-preview',
            prompt_tokens: prompt.length,
            completion_tokens: 0,
            total_tokens: prompt.length,
            source: 'image_generation',
        });
    } catch (e) {
        log.warn('[ImageGen Tool] Failed to log usage:', e.message);
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
