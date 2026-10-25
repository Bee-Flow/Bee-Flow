/**
 * mdToAst.js — parse BeeFlow-Flavored Markdown (BFM) into the editor AST.
 *
 * Hand-written, dependency-free, and shareable between client (ESM) and server
 * (CJS twin) so there is no transitive-dependency fragility. The grammar is the
 * inverse of astToMd.js; the fixture corpus locks the round-trip.
 */
import { doc, emptyParagraph } from '../model/nodes.js';
import { parseBlocks } from './mdToAst.helpers.js';

export function markdownToAst(md: string) {
  const src = String(md == null ? '' : md).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const blocks = parseBlocks(lines);
  if (!blocks.length) blocks.push(emptyParagraph());
  return doc(blocks);
}

/* ── Lists ──────────────────────────────────────────────── */

/* ── Tables ─────────────────────────────────────────────── */

/* ── Inline parsing ─────────────────────────────────────── */

export default markdownToAst;
