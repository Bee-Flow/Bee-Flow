// @typecheck noImplicitAny
'use strict';
// Types only (no runtime exports): the shapes appStudioRender.js hands back.

/**
 * What renderAppScreenshot resolves to: either a screenshot (ok, png, dataUrl,
 * width, height plus diagnostics) or a refusal (unavailable, reason, code).
 *
 * @typedef {object} ScreenshotResult
 * @property {boolean} ok
 * @property {boolean} [unavailable]
 * @property {string} [reason]
 * @property {string} [code]
 * @property {Buffer} [png]
 * @property {string} [dataUrl]
 * @property {number} [width]
 * @property {number} [height]
 * @property {string|null} [mountError]
 * @property {string[]} [pageErrors]
 * @property {string[]} [consoleErrors]
 */

module.exports = {};
