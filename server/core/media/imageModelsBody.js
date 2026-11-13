// @typecheck strict
/**
 * What POST /ai/config accepts as `azureImageModels`: the Azure (Microsoft
 * Foundry) image deployments. Each has the deployment name, the model behind
 * it (it decides which API the deployment answers on, see
 * core/providers/azureImages.mts) and what one image costs, when the admin
 * wants a price on the usage row.
 */

'use strict';

const { z, worded } = require('../http/schemaParts');
const { MAX_AZURE_IMAGE_MODELS } = require('./imageModels.mts');

const DEPLOYMENT_TEXT = 'A deployment name is text of 1 to 128 characters.';
const MODEL_TEXT = 'A model is text of at most 128 characters.';
const PRICE_TEXT = 'The price of one image is a number from zero up, or empty.';

const AzureImageModelsBody = z.array(z.object({
    deployment: worded(DEPLOYMENT_TEXT).trim().min(1, DEPLOYMENT_TEXT).max(128, DEPLOYMENT_TEXT),
    model: worded(MODEL_TEXT).trim().max(128, MODEL_TEXT).optional(),
    pricePerImage: z.number({ error: PRICE_TEXT }).min(0, PRICE_TEXT).max(1000, PRICE_TEXT).nullable().optional(),
}).strict(), { error: 'azureImageModels is a list of image deployments.' })
    .max(MAX_AZURE_IMAGE_MODELS, `At most ${MAX_AZURE_IMAGE_MODELS} image deployments.`).optional();

module.exports = { AzureImageModelsBody };
