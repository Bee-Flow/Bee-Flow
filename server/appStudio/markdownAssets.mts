/**
 * Rich markdown and app assets: the asset ids a markdown text draws as images.
 *
 * A rich markdown block (`markdown` with `props.rich`, since 3) shows `![alt](asset:<id>)` as
 * an uploaded picture of the app. The id sits INSIDE the text, so the whole-string walk of
 * appAssets.mts collectAssetRefs does not see it; this scan does, so the picture counts as
 * used (the asset list, the missing-asset check) and is served on a public page.
 *
 * The scan follows the web's inline parser (runtime/markdownInline.tsx) step for step and uses
 * no pattern: `![`, the first `]`, a `(` right after it, the first `)`, the text between
 * trimmed. Only a plain markdown block with rich on is read, so a definition of an older
 * schema that merely contains this text keeps its version.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { isAssetRef } = nodeRequire('./componentSpecs/valueTypes.js') as { isAssetRef: (v: unknown) => v is string };

const ASSET_PREFIX = 'asset:';

/** Every `asset:<id>` the text draws as an image, in order, with repeats. */
export function markdownAssetRefs(text: unknown): string[] {
    const out: string[] = [];
    if (typeof text !== 'string') return out;
    let at = text.indexOf('![');
    while (at !== -1) {
        const closeBracket = text.indexOf(']', at + 2);
        if (closeBracket === -1) break;
        if (text[closeBracket + 1] === '(') {
            const closeParen = text.indexOf(')', closeBracket + 2);
            if (closeParen === -1) break;
            const ref = text.slice(closeBracket + 2, closeParen).trim();
            if (isAssetRef(ref) && ref.startsWith(ASSET_PREFIX)) out.push(ref.slice(ASSET_PREFIX.length));
        }
        at = text.indexOf('![', at + 2);
    }
    return out;
}

type Visit = (id: string, path: string) => void;

/** Calls `visit(id, path)` for every picture a rich markdown block of `value` draws. */
export function eachRichMarkdownAsset(value: unknown, visit: Visit, path = '', depth = 0, maxDepth = 64): void {
    if (depth > maxDepth || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((item, i) => eachRichMarkdownAsset(item, visit, `${path}[${i}]`, depth + 1, maxDepth));
        return;
    }
    const node = value as Record<string, unknown>;
    const props = node.props as Record<string, unknown> | undefined;
    if (node.type === 'markdown' && props && props.rich === true) {
        for (const id of markdownAssetRefs(props.content)) visit(id, `${path ? `${path}.` : ''}props.content`);
    }
    for (const [key, item] of Object.entries(node)) eachRichMarkdownAsset(item, visit, path ? `${path}.${key}` : key, depth + 1, maxDepth);
}
