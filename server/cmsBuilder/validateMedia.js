// @typecheck
/**
 * CMS builder: page-speed warnings about a page's media.
 *
 *   heavy_hero_image    an image in the first two blocks (above the fold) whose
 *                       stored width is 2400 px or more. Publish stores the
 *                       intrinsic size, not the byte size, and an image that wide
 *                       is far past 300 KB in practice. It is the LCP element, so
 *                       it is the one image that must be light.
 *   autoplay_video      a silent looping video anywhere on the page. It downloads
 *                       on every pageview whether or not the visitor looks at it.
 *   many_media          more than MAX_MEDIA images and videos on one page. Only
 *                       the first image loads eagerly; the rest are lazy, but
 *                       each still costs a request as the visitor scrolls.
 *
 * All warnings, never errors: the page renders and works either way.
 */
'use strict';

const ABOVE_THE_FOLD_BLOCKS = 2;
const HEAVY_WIDTH_PX = 2400;
const MAX_MEDIA = 12;

/** @typedef {{ code: string, path: string, message: string, hint: string }} Finding */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Media objects in a block's content tree: `{ kind: 'image' | 'video-silent' | 'video', src }`.
 * @param {unknown} node
 * @param {string} path
 * @param {{ kind: string, path: string, width: number }[]} out
 */
function collectMedia(node, path, out) {
    if (Array.isArray(node)) {
        node.forEach((child, i) => collectMedia(child, `${path}[${i}]`, out));
        return;
    }
    if (!isObject(node)) return;
    const kind = node.kind;
    if ((kind === 'image' || kind === 'video-silent' || kind === 'video') && typeof node.src === 'string' && node.src) {
        out.push({ kind, path, width: Number.isInteger(node.width) ? Number(node.width) : 0 });
    }
    for (const [k, v] of Object.entries(node)) collectMedia(v, `${path}.${k}`, out);
}

/**
 * @param {string} pageId
 * @param {string} pageName
 * @param {unknown[]} blocks
 * @param {Finding[]} warnings  appended to
 */
function checkPageMedia(pageId, pageName, blocks, warnings) {
    let total = 0;
    let autoplayReported = false;
    blocks.forEach((b, i) => {
        const found = [];
        collectMedia(isObject(b) ? b.content : null, `pages.${pageId}.blocks[${i}].content`, found);
        total += found.length;
        for (const m of found) {
            if (m.kind === 'video-silent' && !autoplayReported) {
                autoplayReported = true;
                warnings.push({
                    code: 'autoplay_video',
                    path: m.path,
                    message: `Page "${pageName}" has an autoplay video. It downloads on every pageview, seen or not.`,
                    hint: 'Use a still image (or a clip the visitor starts) on high-traffic pages; keep the video short and compressed if it stays.',
                });
            }
            if (m.kind === 'image' && i < ABOVE_THE_FOLD_BLOCKS && m.width >= HEAVY_WIDTH_PX) {
                warnings.push({
                    code: 'heavy_hero_image',
                    path: m.path,
                    message: `An image near the top of "${pageName}" is ${m.width} px wide, which is almost certainly over 300 KB. It is the first thing painted.`,
                    hint: `Upload it at about 1600 px wide (or as WebP) so the first screen loads fast; ${HEAVY_WIDTH_PX} px and up is never shown at full size.`,
                });
            }
        }
    });
    if (total > MAX_MEDIA) {
        warnings.push({
            code: 'many_media',
            path: `pages.${pageId}`,
            message: `Page "${pageName}" has ${total} images and videos (more than ${MAX_MEDIA}). Each one is a request as the visitor scrolls.`,
            hint: 'Split the page, or drop the ones that add little.',
        });
    }
}

module.exports = { checkPageMedia, MAX_MEDIA, HEAVY_WIDTH_PX };
