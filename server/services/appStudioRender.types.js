// @typecheck strict
'use strict';
// Types only (no runtime exports): the shapes appStudioRender.js hands back.

/**
 * What renderAppScreenshot resolves to: either a screenshot (ok, png, dataUrl,
 * width, height plus diagnostics) or a refusal (unavailable, reason, code).
 *
 * @typedef {{
 *   ok: boolean, unavailable?: boolean, reason?: string, code?: string, png?: Buffer, dataUrl?: string,
 *   width?: number, height?: number, mountError?: string|null, pageErrors?: string[], consoleErrors?: string[],
 * }} ScreenshotResult
 */

module.exports = {};
