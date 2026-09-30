/**
 * One top-level Markdown block. Memoised on its source: while an answer
 * streams, every block but the last keeps its `raw` and its `live` flag, so
 * only the tail is lexed (block and inline) and rebuilt on a flush — and a
 * finished code block, chart or formula above it is never touched again.
 */

import React, { memo } from 'react';

import type { MarkdownEnv } from './env';
import { lexBlock } from './parse/lexer';
import { renderBlocks } from './render/blocks';

export const MarkdownBlock = memo(function MarkdownBlock({
    raw,
    env,
    index,
    live,
}: {
    raw: string;
    env: MarkdownEnv;
    /** The block's position in the answer; orders its headings for `#anchor` links. */
    index: number;
    /** The answer may still be streaming into this block. */
    live: boolean;
}) {
    const ctx = { env, live, block: index, lists: { ul: 0, ol: 0 } };
    return <>{renderBlocks(lexBlock(raw), ctx, `b${index}`)}</>;
});
