/**
 * Custom block: the stylesheet of one block, as it may be stored.
 *
 * It is the form sanitiser (core/forms/formCss.mts: comments, escapes, the at-rule allow-list,
 * no `</`) with the strictest address rule:
 *   url()                                  only an image given as data (`data:image/…`)
 *   image-set(), image(), cross-fade(), src()   no string at all, and no address from var()
 * No path, no scheme, no `asset:`. The stylesheet lives in the block's own frame, so it is not
 * scoped: there is nothing else in that frame to reach.
 *
 * The browser sanitises the text again with the same rule before it writes the frame
 * (agent-hub …/customBlock/blockCss.ts); keep the two in step.
 */

import { sanitizeCssWith } from '../../core/forms/formCss.mts';
import type { CssAddressPolicy, SanitizedCss } from '../../core/forms/formCss.mts';
import { BLOCK_LIMITS } from '../../shared/blockTemplate/index.mjs';

const isInlineImage = (address: string): boolean => address.startsWith('data:image/');

export const BLOCK_CSS_POLICY: CssAddressPolicy = Object.freeze({
    allowUrl: isInlineImage,
    refuseString: (): boolean => true,
});

export function sanitizeBlockCss(input: unknown): SanitizedCss {
    if (typeof input !== 'string' || !input) return { css: '', removed: [] };
    if (input.length > BLOCK_LIMITS.MAX_CSS_CHARS) return { css: '', removed: [`over ${BLOCK_LIMITS.MAX_CSS_CHARS} characters`] };
    const { css, removed } = sanitizeCssWith(input, BLOCK_CSS_POLICY);
    return { css: css.trim(), removed };
}
