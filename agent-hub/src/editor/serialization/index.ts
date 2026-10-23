/**
 * serialization/index.js — barrel for the BeeEditor serialization seam.
 *
 * The engine and React layer depend only on this interface, never on the
 * individual converter internals. `htmlToAst` (paste + migration) is added in a
 * later phase; until then importing it throws a clear error.
 */
export { markdownToAst } from './mdToAst';
export { astToMarkdown } from './astToMd';
export { astToHtml } from './astToHtml.js';
export { htmlToAst } from './htmlToAst';
export {
  encodeForAttr, decodeFromAttr,
  escapeHtml, escapeAttr, escapeMdText,
} from './util';
