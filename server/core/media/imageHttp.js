// @typecheck strict
/**
 * The image service for a route: one generation billed to the caller, with a
 * refusal of the service turned into the HTTP error the client sees (503
 * nothing configured, 429 image limit reached, 502 the provider failed).
 */

'use strict';

const { HttpError } = require('../http/errors');
const { generateImage, ImageGenerationError } = require('./imageGeneration.mts');

/**
 * @param {{ prompt: string, aspectRatio?: string | null, model?: string | null,
 *   who: { user_id: string | null, organization_id: string | null, agent_id: string | null, agent_name: string | null, conversation_id: string | null } }} input
 * @param {{ notConfiguredCode?: string }} [options]  the error code for "nothing configured" (a route may have had its own before)
 */
async function generateImageForRoute(input, { notConfiguredCode = 'image_not_configured' } = {}) {
    try {
        return await generateImage(input);
    } catch (err) {
        if (err instanceof ImageGenerationError) {
            throw new HttpError(err.status, err.code === 'not_configured' ? notConfiguredCode : `image_${err.code}`, err.message);
        }
        throw err;
    }
}

module.exports = { generateImageForRoute };
