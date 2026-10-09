/**
 * serverEntry.ts — the server's copy of the editor's pure core: the
 * serializers, the shared-document conversion and sync, relative positions
 * and the version diff, so the server materialises, seeds and edits shared
 * documents (and computes version statistics) with exactly the code the
 * browser runs.
 *
 * Bundled to server/core/markdown/editorCollab.cjs (CommonJS, generated,
 * committed). Yjs, y-protocols and lib0 stay external: the bundle must use
 * the server's own Yjs instance, or Yjs types created by one copy fail the
 * other's `instanceof` checks. Regenerate after changing anything this file
 * imports:
 *
 *     cd server && npm run build:editor-collab
 *
 * `htmlToAst(html, DOMParser)` and `diffHtml(a, b, DOMParser)` need a
 * DOMParser from the caller (jsdom on the server), like editorSerialization.
 */
export { markdownToAst, astToMarkdown, astToHtml, htmlToAst } from '../serialization/index.js';
export { normalizeLight } from '../engine/normalize.js';
export { FRAGMENT_NAME } from './ySchema';
export { astToFragment, fragmentToAst, createYCache, sameInY } from './yConvert';
export { syncDocToFragment } from './ySync';
export { relativeFromPos, posFromRelative, encodeRelpos, decodeRelpos } from './relpos';
export { diffDocs, diffHtml, diffMarkdown } from '../diff/index';
export { hunksFrom, anchorsForFragment, applyHunks, hunkWords } from '../suggest/index';
