/**
 * App Studio: the stylesheet an app author writes (`design.customCss`, and the public page's
 * own in `publicAccess.design.customCss`), as it may be stored and served.
 *
 * It is the form sanitiser (core/forms/formCss.mts: comments, escapes, balanced braces, the
 * at-rule allow-list, no `position: fixed`, no `</`) with the address rules of an app. An app
 * runs inside the signed-in product, where a path on this server is a request made as the
 * viewer, so:
 *
 *   url() / src()   only an image as data (`data:image/…`) or a file of the app
 *                   (`asset:<id>`, appAssets.mts). No path, no other scheme.
 *   a string inside image-set() / image() / cross-fade()   only `data:image/…`.
 *
 * Still refused, as for a form: every at-rule but @media, @supports and @container (so
 * @import, @font-face, @keyframes, @scope, @layer, …), `position: fixed`, expression(),
 * behavior:, -moz-binding, javascript:.
 *
 * SCOPE. The page does not nest the text under a class: a nested selector that names its
 * parent inside :has() or :is() can match an element outside it. The text is wrapped in
 * `@scope ([data-app-css-root]) { … }` (wrapAppCss), where the matched element of every rule
 * sits inside the app's root whatever the selector says. A browser without @scope applies
 * none of it. Inside @scope a selector is read from the root down (as if it began with
 * `:scope `), so the root's own attributes are named as `:scope[data-app-dark="true"]`.
 *
 * `asset:<id>` stays in the stored text; the page turns it into the asset's address when it
 * mounts the stylesheet (agent-hub …/runtime/appCss.ts, the client half of this file: keep
 * the two in step, appCss.vectors.json is run by both).
 */

import { createRequire } from 'node:module';
import { sanitizeCssWith } from '../core/forms/formCss.mts';
import type { CssAddressPolicy, SanitizedCss } from '../core/forms/formCss.mts';

const nodeRequire = createRequire(import.meta.url);
const { isAssetRef } = nodeRequire('./componentSpecs/valueTypes.js') as { isAssetRef: (v: unknown) => v is string };
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as { LIMITS: { MAX_CUSTOM_CSS_LEN: number; MAX_CSS_CLASS_LEN: number } };
const MAX_CSS_CLASS_LEN: number = LIMITS.MAX_CSS_CLASS_LEN;

export type { SanitizedCss };

export const APP_CSS_MAX_CHARS: number = LIMITS.MAX_CUSTOM_CSS_LEN;
/** The attribute the page puts on the element the stylesheet is scoped to. */
export const APP_CSS_ROOT_ATTR = 'data-app-css-root';

const ASSET_PREFIX = 'asset:';
const ASSET_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const ASSET_ID_MAX = 64;

const isInlineImage = (address: string): boolean => address.startsWith('data:image/');

/** What an app's stylesheet may name. The sanitiser hands over the address lower-cased. */
export const APP_CSS_POLICY: CssAddressPolicy = Object.freeze({
    allowUrl: (address: string): boolean => isInlineImage(address) || isAssetRef(address),
    refuseString: (address: string): boolean => !isInlineImage(address),
});

/**
 * The stylesheet as it may be stored: `css` is what is kept, `removed` names each kind of
 * removal once (`@import`, `outside address`, `position: fixed`, …). Sanitising the result
 * again changes nothing.
 */
export function sanitizeAppCss(input: unknown): SanitizedCss {
    if (typeof input !== 'string' || !input) return { css: '', removed: [] };
    if (input.length > APP_CSS_MAX_CHARS) return { css: '', removed: [`over ${APP_CSS_MAX_CHARS} characters`] };
    const { css, removed } = sanitizeCssWith(input, APP_CSS_POLICY);
    return { css: css.trim(), removed };
}

/** The sanitised text alone: the `sanitize` of the design key (componentSpecs/valueTypes.js css). */
export function cleanAppCss(text: string): string {
    return sanitizeAppCss(text).css;
}

/** One sentence for the repair list when saving changed the text; null when nothing was removed. */
export function appCssRepairNote(text: unknown): string | null {
    const { removed } = sanitizeAppCss(text);
    return removed.length ? `Removed from the stylesheet because it is not allowed: ${removed.join(', ')}.` : null;
}

const CLASS_FIRST = 'abcdefghijklmnopqrstuvwxyz';
const CLASS_REST = `${CLASS_FIRST}0123456789-`;

/**
 * True for a class name an author may put on a node (`node.cssClass`): a lower-case letter,
 * then lower-case letters, digits or dashes, at most LIMITS.MAX_CSS_CLASS_LEN in all. The page
 * renders it as `u-<name>`, so it can never be a class of the product.
 */
export function isCssClassName(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CSS_CLASS_LEN) return false;
    if (!CLASS_FIRST.includes(value[0])) return false;
    for (const ch of value) if (!CLASS_REST.includes(ch)) return false;
    return true;
}

/**
 * The rule in front of the scope. The root itself is in scope, and `position: absolute` is
 * allowed, so the shell around the root is made the box all of it is laid out in and cut
 * off at: whatever a rule does stays inside the app. The author's text cannot reach the shell.
 */
const APP_CSS_FRAME = `.app-shell:has([${APP_CSS_ROOT_ATTR}]) { position: relative; overflow: clip; }`;

/** The sanitised text inside its scope, behind the frame rule, as the page mounts it. Empty text gives an empty string. */
export function wrapAppCss(css: string): string {
    return css.trim() ? `${APP_CSS_FRAME}\n@scope ([${APP_CSS_ROOT_ATTR}]) {\n${css}\n}` : '';
}

/**
 * The ids of the app's files a stylesheet names: every `asset:<id>` in the text, wherever it
 * stands. Reading more than url() would load is on purpose: this list only decides which
 * files of the app a public page may be asked for.
 */
export function cssAssetIds(css: unknown): string[] {
    if (typeof css !== 'string') return [];
    const ids = new Set<string>();
    let from = 0;
    for (;;) {
        const at = css.indexOf(ASSET_PREFIX, from);
        if (at === -1) break;
        let end = at + ASSET_PREFIX.length;
        while (end < css.length && end - at - ASSET_PREFIX.length < ASSET_ID_MAX && ASSET_ID_CHARS.includes(css[end])) end += 1;
        if (end > at + ASSET_PREFIX.length) ids.add(css.slice(at + ASSET_PREFIX.length, end));
        from = end;
    }
    return [...ids];
}
