/**
 * Which image model a generation request may use, given the models this
 * server is configured with (listImageModels in ./imageModels.mts):
 *
 *   - nothing configured: 503 `image_generation_unavailable`, before anything
 *     is generated;
 *   - a model that is not one of the configured ones (an unknown id, an Azure
 *     deployment that is not in the list): 400 `image_model_unknown`;
 *   - no model: allowed, the media layer then uses the server's default.
 *
 * The caller passes the list in, so this stays a check without I/O.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../http/errors.js') as {
    HttpError: new (status: number, code: string, message: string) => Error;
};

export function assertConfiguredImageModel(models: ReadonlyArray<{ id: string }>, model: string | null | undefined): void {
    if (models.length === 0) {
        throw new HttpError(503, 'image_generation_unavailable', 'Image generation unavailable — no image model is configured.');
    }
    if (model && !models.some((m) => m.id === model)) {
        throw new HttpError(400, 'image_model_unknown', 'model is not one of the configured image models.');
    }
}
