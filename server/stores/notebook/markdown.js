// @typecheck noImplicitAny
/**
 * stores/notebook/markdown.js — the one place the notebook store reaches the
 * HTML/Markdown converter in core/markdown (a stores -> core edge the layer
 * ratchet counts once, as it did before the store was split).
 */

const { tryHtmlToMarkdown, looksLikeHtml } = require('../../core/markdown');

module.exports = { tryHtmlToMarkdown, looksLikeHtml };
