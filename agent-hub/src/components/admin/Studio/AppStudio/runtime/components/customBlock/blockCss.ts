import { FORM_CSS_POLICY, sanitizeCssClientWith } from '@/components/forms/formCssSanitizer';
import type { CssAddressPolicy, SanitizedCss } from '@/components/forms/formCssSanitizer';
import { BLOCK_LIMITS } from '@shared/blockTemplate/index.mjs';

/**
 * The stylesheet of one custom block on the web: the client half of
 * server/appStudio/customBlock/blockCss.mts. Keep the two in step.
 *
 * It is the form sanitiser with the strictest address rule:
 *   url()                                       only an image given as data (`data:image/…`)
 *   image-set(), image(), cross-fade(), src()   no string at all, and no address from var()
 *   a string that reads as an address           nowhere
 * The server stores the text sanitised; the page sanitises it AGAIN before it writes the
 * block's frame, so text that never passed this server's canonicalizer gets the same rules.
 */

const IMAGE_FUNCTIONS = ['image-set(', 'image(', 'cross-fade(', 'src('];
const ADDRESS_SOURCES = ['var(', 'attr(', 'env('];

const isInlineImage = (address: string): boolean => address.trim().toLowerCase().startsWith('data:image/');

/** A declaration that builds an image from anything but url(): a string, or a value from elsewhere. */
function imageFunctionProblem(decoded: string): string | null {
    const lower = decoded.toLowerCase();
    if (!IMAGE_FUNCTIONS.some((fn) => lower.includes(fn))) return null;
    if (ADDRESS_SOURCES.some((fn) => lower.includes(fn))) return 'address from var()';
    return lower.includes('"') || lower.includes("'") ? 'outside address' : null;
}

const BLOCK_CSS_POLICY: CssAddressPolicy = Object.freeze({
    allowUrl: isInlineImage,
    refuseString: FORM_CSS_POLICY.refuseString,
    refuseSegment: imageFunctionProblem,
});

export const BLOCK_CSS_MAX: number = BLOCK_LIMITS.MAX_CSS_CHARS;

export function sanitizeBlockCssClient(input: unknown): SanitizedCss {
    if (typeof input !== 'string' || !input) return { css: '', removed: [] };
    if (input.length > BLOCK_CSS_MAX) return { css: '', removed: [`over ${BLOCK_CSS_MAX} characters`] };
    const { css, removed } = sanitizeCssClientWith(input, BLOCK_CSS_POLICY);
    return { css: css.trim(), removed };
}
