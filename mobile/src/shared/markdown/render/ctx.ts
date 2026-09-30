/** What a render pass over one block's tokens carries. */

import type { TextStyle } from 'react-native';

import type { MarkdownEnv } from '../env';

export interface RenderCtx {
    env: MarkdownEnv;
    /**
     * The answer may still be streaming into this block: it is the last one
     * and the caller has not said the stream ended. An unclosed fence or
     * formula here is still arriving, not broken.
     */
    live: boolean;
    /** This block's position in the answer, which orders its headings. */
    block: number;
    /** How many bullet and numbered lists enclose what is being rendered. */
    lists: { ul: number; ol: number };
    /** Inside a blockquote, whose words are the secondary ink on the web. */
    quoted?: boolean;
}

/** Styles an inline run inherits from what encloses it (a heading, a table cell, a quote). */
export type InlineStyle = TextStyle | undefined;
