// @typecheck strict
'use strict';
/**
 * How a content image is offered to the browser: the `srcset` of resized
 * variants, the `sizes` for a layout, and the head preload of the first image.
 * The server-rendered HTML (core/seo/renderBlocks.js) and the hydrated page
 * (agent-hub/src/marketing/assetUrl.ts, kept in step by hand) must agree, or
 * the browser fetches one file for first paint and another after hydration.
 */

const { VARIANT_WIDTHS } = require('./assetVariants');
const { esc } = require('../seo/html');

const NO_VARIANT_EXT = /\.(svg|gif|apng|mp4|webm|vtt)(\?|$)/i;
/** Full content width: the content column tops out at 1200 px. */
const DEFAULT_SIZES = '(min-width: 1200px) 1200px, 100vw';

/**
 * @param {string} url the resolved image URL
 * @returns {string | undefined} srcset, or undefined when the image has no variants
 */
function variantSrcSet(url) {
    if (!url.startsWith('/api/cms/asset/') || url.includes('?') || NO_VARIANT_EXT.test(url)) return undefined;
    return VARIANT_WIDTHS.map((w) => `${url}?w=${w} ${w}w`).join(', ');
}

/**
 * `sizes` for an image in a grid of equal columns: one column on a phone,
 * (content width - gutters) / columns from a tablet up.
 * @param {number} columns
 */
function columnSizes(columns) {
    if (!Number.isInteger(columns) || columns < 2) return DEFAULT_SIZES;
    return `(min-width: 1024px) calc((min(100vw, 1200px) - 96px) / ${columns}), 100vw`;
}

/**
 * @param {{ src: string, srcset?: string, sizes?: string }} image
 * @returns {string} a `<link rel="preload" as="image">` for the LCP candidate
 */
function preloadLink(image) {
    const set = image.srcset ? ` imagesrcset="${esc(image.srcset)}" imagesizes="${esc(image.sizes || DEFAULT_SIZES)}"` : '';
    return `<link rel="preload" as="image" href="${esc(image.src)}"${set} fetchpriority="high">`;
}

module.exports = { DEFAULT_SIZES, variantSrcSet, columnSizes, preloadLink };
