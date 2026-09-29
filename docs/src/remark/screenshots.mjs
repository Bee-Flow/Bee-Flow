/**
 * Folder-style screenshot resolver — port of hooks/screenshots.py to remark.
 *
 * Convention:
 *   ![alt](../img/screenshots/<topic>/)   ← URL ends with "/"
 *
 * On build, we look inside that folder and rewrite the image to point at
 * the first image file found (alphabetically). If none, the image is
 * removed entirely so the build keeps going.
 */

import {visit} from 'unist-util-visit';
import path from 'node:path';
import fs from 'node:fs';

const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const SCREENSHOT_RE = /(?:\.\.\/)*img\/screenshots\/[^\s()]+\/$/;

function firstImageIn(folder) {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return null;
  const files = fs.readdirSync(folder)
    .filter((f) => !f.startsWith('.'))
    .filter((f) => IMG_EXTS.has(path.extname(f).toLowerCase()))
    .sort();
  return files.length ? path.join(folder, files[0]) : null;
}

export default function remarkScreenshots() {
  return (tree, file) => {
    const sourceFile = file.history[0] || file.path;
    if (!sourceFile) return;
    const pageDir = path.dirname(sourceFile);

    const removals = [];

    visit(tree, 'image', (node, index, parent) => {
      const url = node.url || '';
      if (!url.endsWith('/')) return;
      if (!SCREENSHOT_RE.test(url)) return;

      const folderAbs = path.resolve(pageDir, url);
      const img = firstImageIn(folderAbs);
      if (img) {
        let rel = path.relative(pageDir, img).split(path.sep).join('/');
        if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
        node.url = rel;
      } else {
        // No image yet — drop the node so the build doesn't try to read a directory.
        removals.push({parent, index});
      }
    });

    // Splice in reverse to keep indexes stable.
    removals.sort((a, b) => b.index - a.index).forEach(({parent, index}) => {
      if (!parent || !Array.isArray(parent.children)) return;
      // If the image is the only child of a paragraph, remove the paragraph too.
      if (parent.type === 'paragraph' && parent.children.length === 1) {
        // Caller will handle it on the next visit (paragraph becomes empty);
        // safe to leave as empty paragraph — it renders nothing.
      }
      parent.children.splice(index, 1);
    });
  };
}
