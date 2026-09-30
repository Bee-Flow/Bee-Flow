/**
 * server/core/markdown — server-side BFM (BeeFlow-Flavored Markdown) converters.
 *
 * `editorSerialization.cjs` is a self-contained esbuild bundle of the SAME
 * client serialization core (agent-hub/src/editor/serialization), so the server
 * and the new editor speak an identical Markdown dialect with zero hand-kept
 * duplication and zero runtime coupling to the frontend source tree.
 *
 *   Regenerate after changing the client serializers:
 *     cd server && npm run build:editor-md
 */
const S = require('./editorSerialization.cjs');

let _DOMParser = null;
function domParser() {
  if (_DOMParser) return _DOMParser;
  const { JSDOM } = require('jsdom');
  _DOMParser = new JSDOM('').window.DOMParser;
  return _DOMParser;
}

/** BFM Markdown → HTML (engine/export-shaped: mermaid base64 div, <img data-*>, etc.). */
function markdownToHtml(md) {
  try { return S.astToHtml(S.markdownToAst(md || '')); } catch (e) { return md || ''; }
}

/** HTML → BFM Markdown (token-efficient; understands legacy TipTap node shapes). */
function htmlToMarkdown(html) {
  try { return S.astToMarkdown(S.htmlToAst(html || '', domParser())); } catch (e) { return ''; }
}

/**
 * Like htmlToMarkdown, but reports failure instead of silently yielding ''.
 *
 * The lenient version above is right for read paths (a best-effort rendering
 * beats an exception). It is wrong for WRITE paths: persisting its '' would
 * blank a document's Markdown mirror because the parse tripped, which reads as
 * "the user emptied the document" to everything downstream.
 */
function tryHtmlToMarkdown(html) {
  try { return { ok: true, md: S.astToMarkdown(S.htmlToAst(html || '', domParser())) }; }
  catch (e) { return { ok: false, md: null, error: e }; }
}

/**
 * Cheap "is this HTML rather than Markdown?" test.
 * Mirrors the client's contentPipeline.js check so both sides classify a
 * document body the same way.
 */
const HTML_LIKE = /<\/?[a-z][\s\S]*>/i;
function looksLikeHtml(s) { return HTML_LIKE.test(s || ''); }

module.exports = {
  markdownToHtml,
  htmlToMarkdown,
  tryHtmlToMarkdown,
  looksLikeHtml,
  markdownToAst: (md) => S.markdownToAst(md || ''),
  /** HTML → the editor's AST, losslessly for the editor's own HTML (throws on a parse failure). */
  htmlToAst: (html) => S.htmlToAst(html || '', domParser()),
  astToMarkdown: (ast) => S.astToMarkdown(ast),
  astToHtml: (ast) => S.astToHtml(ast),
};
