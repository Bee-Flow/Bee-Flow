// @typecheck
'use strict';
/**
 * Variants of an uploaded CMS image, written to storage next to the original
 * (`cms-variants/<name>@<width>.<format>`) right after the upload, so the
 * public asset route serves them as plain immutable files instead of
 * rendering them for the first visitors after a restart.
 *
 * Fail safe: a bad or huge image, a busy queue or a storage error only means
 * that no stored variant exists; the route then renders on demand
 * (assetVariants.js) or serves the original. Nothing leaves the server.
 * Rendering is one image at a time, in the background, with a short queue.
 */

const { VARIANT_WIDTHS, VARIANT_FORMATS, MAX_SOURCE_BYTES, isResizable, resize } = require('./assetVariants');
const log = require('../../telemetry/log');

const PREFIX = 'cms-variants/';
const MAX_QUEUED = 20;

/** @typedef {{ uploadFile(key: string, body: Buffer, type: string, meta?: object | null): Promise<unknown> }} VariantSink */

/** @type {Promise<void>} */
let tail = Promise.resolve();
let queued = 0;

/**
 * @param {string} key an uploaded asset key (`cms/<name>`)
 * @param {number} width
 * @param {'avif' | 'webp'} format
 * @returns {string}
 */
function variantKey(key, width, format) {
    return `${PREFIX}${key.replace(/^cms\//, '')}@${width}.${format}`;
}

/**
 * Renders and stores every width and format of one image. Never throws.
 * @param {{ key: string, source: Buffer, contentType: string, storage: VariantSink }} job
 * @returns {Promise<number>} how many variants were stored
 */
async function storeVariants({ key, source, contentType, storage }) {
    if (!isResizable(contentType) || source.length > MAX_SOURCE_BYTES) return 0;
    let stored = 0;
    for (const format of VARIANT_FORMATS) {
        for (const width of VARIANT_WIDTHS) {
            try {
                const out = await resize(source, width, format);
                if (!out) continue;
                await storage.uploadFile(variantKey(key, width, format), out, `image/${format}`);
                stored++;
            } catch (err) {
                log.warn(`[CmsVariants] ${key} ${width}.${format} skipped: ${err.message}`);
            }
        }
    }
    return stored;
}

/**
 * Queues {@link storeVariants} behind earlier uploads; drops the job when the
 * queue is full (the on-demand route covers it).
 * @param {{ key: string, source: Buffer, contentType: string, storage: VariantSink }} job
 * @returns {Promise<number>} resolves when the job ran (0 when dropped)
 */
function scheduleVariants(job) {
    if (queued >= MAX_QUEUED) return Promise.resolve(0);
    queued++;
    const run = tail.then(() => storeVariants(job));
    tail = run.then(() => undefined, () => undefined);
    return run.finally(() => { queued--; });
}

module.exports = { variantKey, storeVariants, scheduleVariants };
