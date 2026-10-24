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
const { bestEffort } = require('../../utils/bestEffort');

const PREFIX = 'cms-variants/';
const MAX_QUEUED = 20;
/** Keys looked at per backfill run: the rest follow on the next boot. */
const BACKFILL_MAX = 50;
const IMAGE_KEY_RE = /\.(png|jpe?g|webp)$/i;

/** @typedef {{ uploadFile(key: string, body: Buffer, type: string, meta?: object | null): Promise<unknown> }} VariantSink */
/** @typedef {VariantSink & { listKeys(prefix: string): Promise<string[]>, streamFile(key: string): Promise<{ stream: import('stream').Readable, contentType?: string }> }} BackfillStorage */

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

/** @param {string} key */
const doneKey = (key) => `${PREFIX}${key.replace(/^cms\//, '')}.done`;

/**
 * Renders and stores every width and format of one image. Never throws.
 * @param {{ key: string, source: Buffer, contentType: string, storage: VariantSink }} job
 * @returns {Promise<number>} how many variants were stored
 */
async function storeVariants({ key, source, contentType, storage }) {
    if (!isResizable(contentType) || source.length > MAX_SOURCE_BYTES) return 0;
    let stored = 0;
    let failed = false;
    for (const format of VARIANT_FORMATS) {
        for (const width of VARIANT_WIDTHS) {
            try {
                const out = await resize(source, width, format);
                if (!out) continue;
                await storage.uploadFile(variantKey(key, width, format), out, `image/${format}`);
                stored++;
            } catch (err) {
                failed = true;
                log.warn(`[CmsVariants] ${key} ${width}.${format} skipped: ${err.message}`);
            }
        }
    }
    // Marks the image as handled, so the backfill does not redo images that need no variants.
    if (!failed) await storage.uploadFile(doneKey(key), Buffer.from('1'), 'text/plain').catch((e) => bestEffort('core/cms/assetVariantStore:storeVariants', e));
    return stored;
}

/**
 * Runs `task` behind earlier jobs; drops it when the queue is full (the
 * on-demand route covers that image).
 * @param {() => Promise<number>} task
 * @returns {Promise<number>} what the task returned (0 when dropped)
 */
function enqueue(task) {
    if (queued >= MAX_QUEUED) return Promise.resolve(0);
    queued++;
    const run = tail.then(task);
    tail = run.then(() => undefined, () => undefined);
    return run.finally(() => { queued--; });
}

/**
 * Queues {@link storeVariants} behind earlier uploads.
 * @param {{ key: string, source: Buffer, contentType: string, storage: VariantSink }} job
 * @returns {Promise<number>} resolves when the job ran (0 when dropped)
 */
function scheduleVariants(job) {
    return enqueue(() => storeVariants(job));
}

/**
 * Variants for images that were uploaded before they existed: at most
 * BACKFILL_MAX images without a `.done` marker, newest first, each through
 * the same queue. Never throws.
 * @param {BackfillStorage} storage
 * @returns {Promise<number>} images handled
 */
async function backfillVariants(storage) {
    let handled = 0;
    try {
        const done = new Set(await storage.listKeys(PREFIX));
        const todo = (await storage.listKeys('cms/'))
            .filter((k) => IMAGE_KEY_RE.test(k) && !done.has(doneKey(k)))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .slice(0, BACKFILL_MAX);
        for (const key of todo) {
            const ran = await enqueue(async () => {
                const { stream, contentType } = await storage.streamFile(key);
                const source = await require('node:stream/consumers').buffer(stream);
                await storeVariants({ key, source, contentType: contentType || '', storage });
                // Not an image we resize (by its stored type): never look at it again.
                if (!isResizable(contentType)) await storage.uploadFile(doneKey(key), Buffer.from('1'), 'text/plain');
                return 1;
            }).catch((err) => {
                log.warn(`[CmsVariants] backfill of ${key} skipped: ${err.message}`);
                return 0;
            });
            handled += ran;
        }
    } catch (err) {
        // Local-fs mode (no listing) or a storage outage: nothing to backfill now.
        log.warn(`[CmsVariants] backfill skipped: ${err.message}`);
    }
    return handled;
}

module.exports = { variantKey, storeVariants, scheduleVariants, backfillVariants };
